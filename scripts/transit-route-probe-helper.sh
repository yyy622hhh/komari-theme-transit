#!/usr/bin/env bash
# Transit 三网回程节点助手。
#
# 它不监听端口，也不接受命令、IP 或 traceroute 参数。服务端只能返回一次性任务 ID
# 和 beijing/shanghai/guangzhou 三个固定城市之一，实际目标由本机的
# collect-return-route.sh 选择。助手复用本节点现有 Komari Agent token，通过 HTTPS
# 主动轮询伴生插件，因此节点无需开放任何入站端口。

set -uo pipefail

VERSION="1.4.2"
DEFAULT_CONFIG="/etc/transit-route-probe.conf"
INSTALL_DIR="/usr/local/libexec/transit-route-probe"
SERVICE_NAME="transit-route-probe"
SERVICE_USER="transit-route-probe"
NORMAL_POLL_MIN=12
NORMAL_POLL_MAX=18
MAX_RETRY_AFTER=3600
POLL_OUTCOME=success
POLL_RETRY_AFTER=""
LAST_POLL_ERROR=""
RUNTIME_WORK_DIR=""

usage() {
  cat <<'EOF'
用法：
  transit-route-probe-helper.sh install --endpoint https://status.example.com
  transit-route-probe-helper.sh run [--config /etc/transit-route-probe.conf]
  transit-route-probe-helper.sh once [--config /etc/transit-route-probe.conf]
  transit-route-probe-helper.sh uninstall

install 必须在本仓库 scripts/ 目录中的原始脚本上运行，因为它会同时安装
collect-return-route.sh。默认只接受 HTTPS；仅本机测试可额外传 --allow-insecure-http。
EOF
}

fail() {
  echo "Transit Route Probe: $*" >&2
  exit 1
}

need_value() {
  [ "$2" -ge 2 ] || fail "参数 $1 缺少取值"
}

valid_endpoint() {
  local scheme host port
  [[ "$1" =~ ^(https?)://([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])(:([0-9]{1,5}))?$ ]] || return 1
  scheme="${BASH_REMATCH[1]}" host="${BASH_REMATCH[2]}" port="${BASH_REMATCH[4]}"
  if [ -n "$port" ]; then
    [ "$((10#$port))" -ge 1 ] && [ "$((10#$port))" -le 65535 ] || return 1
  fi
  if [ "$scheme" = http ]; then
    [ "${ALLOW_INSECURE_HTTP:-0}" = 1 ] || return 1
    # Deliberate local-test exception only; never resolve a hostname to decide this.
    [ "$host" = 127.0.0.1 ] || [ "$host" = '[::1]' ] || return 1
  fi
}

valid_token() {
  [ -n "$1" ] && [ "${#1}" -le 512 ] && [[ "$1" =~ ^[A-Za-z0-9._~-]+$ ]]
}

read_config() {
  local config="$1"
  [ -r "$config" ] || fail "无法读取配置：$config"
  ENDPOINT=$(sed -n 's/^endpoint=//p' "$config" | head -n 1)
  TOKEN=$(sed -n 's/^token=//p' "$config" | head -n 1)
  ALLOW_INSECURE_HTTP=$(sed -n 's/^allow_insecure_http=//p' "$config" | head -n 1)
  ALLOW_INSECURE_HTTP=${ALLOW_INSECURE_HTTP:-0}
  ENDPOINT=${ENDPOINT%/}
  valid_endpoint "$ENDPOINT" || fail "endpoint 必须是无空白字符的 HTTPS 地址"
  valid_token "$TOKEN" || fail "Agent token 格式不受支持"
}

make_curl_config() {
  local url="$1" output="$2"
  (
    umask 077
    set -C
    printf 'url = "%s"\nsilent\nshow-error\ngloboff\nmax-filesize = 16384\nconnect-timeout = 10\nmax-time = 25\nheader = "User-Agent: Transit-Route-Probe/%s"\n' "$url" "$VERSION" >"$output"
  )
}

create_runtime() {
  local base="${RUNTIME_DIRECTORY:-}" mode
  if [ -n "$base" ]; then
    [ -d "$base" ] && [ ! -L "$base" ] && [ -O "$base" ] || return 1
    mode=$(stat -c %a "$base" 2>/dev/null) || mode=$(stat -f %Lp "$base") || return 1
    [ "$mode" = 700 ] || return 1
    RUNTIME_WORK_DIR=$(mktemp -d "$base/request.XXXXXXXX") || return 1
  else
    RUNTIME_WORK_DIR=$(mktemp -d /tmp/transit-route-probe.XXXXXXXX) || return 1
  fi
}

cleanup_runtime() {
  [ -n "$RUNTIME_WORK_DIR" ] || return 0
  # Only our fresh request directory; never recursively delete a configured runtime root.
  local file
  for file in poll.curl poll.json poll.body poll.headers result.curl result.json result.body collector.log; do
    rm -f -- "$RUNTIME_WORK_DIR/$file" || return 1
  done
  rmdir -- "$RUNTIME_WORK_DIR" || return 1
  RUNTIME_WORK_DIR=""
}

write_request_json() (
  umask 077
  set -C
  local output="$1" job_id="${2:-}" field="${3:-}" value="${4:-}" duration_ms="${5:-}"
  valid_token "$TOKEN" || return 1
  if [ -n "$job_id" ]; then
    [[ "$job_id" =~ ^[A-Za-z0-9_-]{8,96}$ ]] || return 1
    case "$field" in
      tag) [[ "$value" =~ ^transit-route:ct=[0-9.]*,cu=[0-9.]*,cm=[0-9.]*@[0-9]{10,13}$ ]] || return 1 ;;
      error) case "$value" in no-traceroute|probe-failed|invalid-city|internal-error) :;; *) return 1;; esac ;;
      *) return 1 ;;
    esac
    [ -z "$duration_ms" ] || [[ "$duration_ms" =~ ^[0-9]{1,9}$ ]] || return 1
  fi
  # All strings above have a quote/backslash-free alphabet; token never enters argv or URL.
  {
    printf '{"token":"%s"' "$TOKEN" || return 1
    if [ -n "$job_id" ]; then printf ',"job_id":"%s","%s":"%s"' "$job_id" "$field" "$value" || return 1; fi
    if [ -n "$duration_ms" ]; then printf ',"duration_ms":%s' "$duration_ms" || return 1; fi
    printf '}\n'
  } >"$output"
)

poll_once() {
  read_config "$1"
  command -v curl >/dev/null 2>&1 || fail "缺少 curl"
  command -v timeout >/dev/null 2>&1 || fail "缺少 timeout（coreutils）"
  create_runtime || fail "无法创建安全运行目录；请检查目录属主和 0700 权限"
  local result=0
  poll_request "$RUNTIME_WORK_DIR" || result=$?
  cleanup_runtime || fail "无法清理本次运行的临时凭据"
  return "$result"
}

post_result() {
  local job_id="$1" field="$2" value="$3" runtime_dir="$4" duration_ms="${5:-}"
  local request_config="$runtime_dir/result.curl" response="$runtime_dir/result.body"
  make_curl_config "$ENDPOINT/api/transit-route-probe/v1/result" "$request_config" || return 1
  write_request_json "$runtime_dir/result.json" "$job_id" "$field" "$value" "$duration_ms" || return 1
  local status
  status=$(curl -q --config "$request_config" \
    --request POST \
    --header 'Content-Type: application/json' \
    --data-binary "@$runtime_dir/result.json" \
    --output "$response" \
    --write-out '%{http_code}') || return 1
  [ "$status" = "200" ] || {
    echo "Transit Route Probe: 提交结果失败（HTTP ${status}）" >&2
    return 1
  }
}

read_retry_after() {
  local headers="$1" value
  value=$(sed -n 's/^[Rr]etry-[Aa]fter:[[:space:]]*\([0-9][0-9]*\)[[:space:]\r]*$/\1/p' "$headers" | tail -n 1)
  if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le "$MAX_RETRY_AFTER" ]; then
    POLL_RETRY_AFTER="$value"
  else
    POLL_RETRY_AFTER=""
  fi
}

log_poll_error() {
  local key="$1" message="$2"
  if [ "$LAST_POLL_ERROR" != "$key" ]; then
    echo "Transit Route Probe: $message" >&2
    LAST_POLL_ERROR="$key"
  fi
}

random_between() {
  local minimum="$1" maximum="$2"
  echo $((minimum + RANDOM % (maximum - minimum + 1)))
}

jittered_backoff() {
  local base="$1"
  local spread=$((base / 5))
  random_between $((base - spread)) $((base + spread))
}

poll_request() {
  local runtime_dir="$1"
  local request_config="$runtime_dir/poll.curl" response="$runtime_dir/poll.body" headers="$runtime_dir/poll.headers"
  make_curl_config "$ENDPOINT/api/transit-route-probe/v1/poll" "$request_config" || return 1
  write_request_json "$runtime_dir/poll.json" || return 1

  local status
  POLL_RETRY_AFTER=""
  status=$(curl -q --config "$request_config" --request POST --header 'Content-Type: application/json' \
    --data-binary "@$runtime_dir/poll.json" --dump-header "$headers" --output "$response" --write-out '%{http_code}') || {
    POLL_OUTCOME=retry
    log_poll_error network "无法连接 Komari"
    return 0
  }
  read_retry_after "$headers"
  case "$status" in
    204)
      POLL_OUTCOME=success
      LAST_POLL_ERROR=""
      return 0
      ;;
    401|403)
      POLL_OUTCOME=fixed
      log_poll_error "http-$status" "Agent token 未通过认证（HTTP ${status}）"
      return 0
      ;;
    404|405)
      POLL_OUTCOME=fixed
      log_poll_error "http-$status" "请安装、启用或升级伴生插件以支持安全 POST 轮询；不会回退到 URL 凭据"
      return 0
      ;;
    200)
      POLL_OUTCOME=success
      LAST_POLL_ERROR=""
      ;;
    5??)
      POLL_OUTCOME=retry
      log_poll_error "http-$status" "轮询失败（HTTP ${status}）"
      return 0
      ;;
    *)
      POLL_OUTCOME=retry
      log_poll_error "http-$status" "轮询失败（HTTP ${status}）"
      return 0
      ;;
  esac

  local line job_id city extra city_code
  IFS= read -r line <"$response" || true
  IFS=$'\t' read -r job_id city extra <<<"$line"
  [[ "$job_id" =~ ^[A-Za-z0-9_-]{8,96}$ ]] || {
    echo "Transit Route Probe: 收到非法任务 ID，已拒绝" >&2
    return 0
  }
  [ -z "${extra:-}" ] || {
    echo "Transit Route Probe: 收到多余任务字段，已拒绝" >&2
    return 0
  }
  case "$city" in
    beijing) city_code=bj ;;
    shanghai) city_code=sh ;;
    guangzhou) city_code=gz ;;
    *)
      post_result "$job_id" error invalid-city "$runtime_dir" || true
      return 0
      ;;
  esac

  if ! command -v traceroute >/dev/null 2>&1; then
    post_result "$job_id" error no-traceroute "$runtime_dir" || true
    return 0
  fi

  local collector="$INSTALL_DIR/collect-return-route.sh" tag started_at finished_at duration_ms
  [ -x "$collector" ] || {
    post_result "$job_id" error internal-error "$runtime_dir" || true
    return 0
  }
  started_at=$(date +%s%3N)
  tag=$(timeout 150 "$collector" --city "$city_code" 2>"$runtime_dir/collector.log") || {
    finished_at=$(date +%s%3N)
    duration_ms=$((finished_at - started_at))
    post_result "$job_id" error probe-failed "$runtime_dir" "$duration_ms" || true
    return 0
  }
  finished_at=$(date +%s%3N)
  duration_ms=$((finished_at - started_at))
  [[ "$tag" =~ ^transit-route:ct=[0-9.]*,cu=[0-9.]*,cm=[0-9.]*@[0-9]{10,13}$ ]] || {
    post_result "$job_id" error probe-failed "$runtime_dir" "$duration_ms" || true
    return 0
  }
  local chains=${tag#transit-route:}
  chains=${chains%@*}
  [ "$chains" != "ct=,cu=,cm=" ] || {
    post_result "$job_id" error probe-failed "$runtime_dir" "$duration_ms" || true
    return 0
  }
  post_result "$job_id" tag "$tag" "$runtime_dir" "$duration_ms" || true
}

run_loop() {
  local config="$1"
  local retry_index=0 delay retry_after
  local -a retry_steps=(15 30 60 120 300)
  while :; do
    poll_once "$config" || fail "探测请求本地处理失败"
    retry_after="$POLL_RETRY_AFTER"
    case "$POLL_OUTCOME" in
      success)
        retry_index=0
        delay=$(random_between "$NORMAL_POLL_MIN" "$NORMAL_POLL_MAX")
        ;;
      fixed)
        retry_index=0
        delay=300
        ;;
      *)
        delay=$(jittered_backoff "${retry_steps[$retry_index]}")
        [ "$retry_index" -ge 4 ] || retry_index=$((retry_index + 1))
        ;;
    esac
    [ -z "$retry_after" ] || delay="$retry_after"
    sleep "$delay" &
    wait $! || exit 0
  done
}

install_helper() (
  # Installer failures must stop here; the long-running polling loop intentionally has no -e.
  set -e
  umask 077
  # Subshell-scoped variables survive function unwinding until the EXIT trap (also on Bash 3).
  config_temp="" service_temp=""
  trap 'result=$?; set +e; [ -z "$config_temp" ] || rm -f -- "$config_temp"; [ -z "$service_temp" ] || rm -f -- "$service_temp"; if [ "$result" -ne 0 ]; then echo "Transit Route Probe 安装未完成，请检查权限、磁盘空间和服务状态。" >&2; fi; exit "$result"' EXIT
  [ "$(id -u)" -eq 0 ] || fail "install 需要 root"
  command -v systemctl >/dev/null 2>&1 || fail "当前系统没有 systemd"
  command -v curl >/dev/null 2>&1 || fail "缺少 curl，安装器不会自动安装系统软件"
  command -v timeout >/dev/null 2>&1 || fail "缺少 timeout（coreutils），安装器不会自动安装系统软件"
  local endpoint="" token="" token_file="" allow_insecure=0
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --endpoint) need_value "$1" $#; endpoint="$2"; shift 2 ;;
      --token) fail "请使用交互输入或 --token-file，禁止把 token 放入命令行" ;;
      --token-file) need_value "$1" $#; token_file="$2"; shift 2 ;;
      --allow-insecure-http) allow_insecure=1; shift ;;
      *) fail "未知安装参数：$1" ;;
    esac
  done
  ALLOW_INSECURE_HTTP=$allow_insecure
  endpoint=${endpoint%/}
  valid_endpoint "$endpoint" || fail "--endpoint 默认必须使用 HTTPS"
  if [ -n "$token_file" ]; then
    [ -r "$token_file" ] || fail "无法读取 --token-file"
    IFS= read -r token <"$token_file" || true
  elif [ -z "$token" ] && [ -t 0 ]; then
    read -r -s -p '请输入该节点现有 Komari Agent token：' token
    echo >&2
  fi
  valid_token "$token" || fail "不是受支持的 Agent token 格式"

  local source_dir
  source_dir=$(cd "$(dirname "$0")" && pwd)
  [ -f "$source_dir/collect-return-route.sh" ] \
    || fail "请把本脚本与 collect-return-route.sh 放在同一目录后安装"

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell "$(command -v nologin || echo /usr/sbin/nologin)" "$SERVICE_USER"
  fi
  install -d -o root -g root -m 0755 "$INSTALL_DIR"
  install -o root -g root -m 0755 "$0" "$INSTALL_DIR/helper.sh"
  install -o root -g root -m 0755 "$source_dir/collect-return-route.sh" "$INSTALL_DIR/collect-return-route.sh"
  config_temp=$(mktemp "${DEFAULT_CONFIG}.tmp.XXXXXX")
  {
    printf 'endpoint=%s\n' "$endpoint"
    printf 'token=%s\n' "$token"
    printf 'allow_insecure_http=%s\n' "$allow_insecure"
  } >"$config_temp"
  chown root:"$SERVICE_USER" "$config_temp"
  chmod 0640 "$config_temp"
  mv -f -- "$config_temp" "$DEFAULT_CONFIG"
  config_temp=""

  local service_file="/etc/systemd/system/$SERVICE_NAME.service"
  service_temp=$(mktemp "${service_file}.tmp.XXXXXX")
  {
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=Transit fixed-purpose return-route probe'
    printf '%s\n' 'After=network-online.target'
    printf '%s\n' 'Wants=network-online.target'
    printf '%s\n' '' '[Service]'
    printf 'User=%s\nGroup=%s\n' "$SERVICE_USER" "$SERVICE_USER"
    printf 'ExecStart=%s/helper.sh run --config %s\n' "$INSTALL_DIR" "$DEFAULT_CONFIG"
    printf '%s\n' 'Restart=always' 'RestartSec=15s'
    printf '%s\n' 'RuntimeDirectory=transit-route-probe' 'RuntimeDirectoryMode=0700'
    printf '%s\n' 'NoNewPrivileges=true' 'PrivateTmp=true' 'PrivateDevices=true'
    printf '%s\n' 'ProtectSystem=strict' 'ProtectHome=true' 'ProtectControlGroups=true' 'ProtectKernelModules=true' 'ProtectKernelTunables=true'
    printf '%s\n' 'RestrictAddressFamilies=AF_INET AF_INET6' 'RestrictSUIDSGID=true' 'LockPersonality=true' 'MemoryDenyWriteExecute=true'
    printf '%s\n' 'CapabilityBoundingSet=CAP_NET_RAW' 'AmbientCapabilities=CAP_NET_RAW' 'UMask=0077'
    printf '%s\n' '' '[Install]' 'WantedBy=multi-user.target'
  } >"$service_temp"
  chmod 0644 "$service_temp"
  mv -f -- "$service_temp" "$service_file"
  service_temp=""
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME.service"
  # start/enable --now is a no-op for an already running old helper. Apply upgrades too.
  systemctl restart "$SERVICE_NAME.service"
  systemctl is-active --quiet "$SERVICE_NAME.service"
  echo "Transit Route Probe 已安装。查看状态：systemctl status $SERVICE_NAME" >&2
)

uninstall_helper() {
  [ "$(id -u)" -eq 0 ] || fail "uninstall 需要 root"
  systemctl disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service" "$DEFAULT_CONFIG"
  rm -rf "$INSTALL_DIR"
  systemctl daemon-reload
  echo "Transit Route Probe 已卸载；专用系统用户仍保留，可手动删除。" >&2
}

# Sourcing exposes only the fixed-purpose functions for execution tests, never an installer.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

MODE=${1:-}
case "$MODE" in
  install) install_helper "$@" ;;
  uninstall) uninstall_helper ;;
  run|once)
    trap cleanup_runtime EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    shift
    CONFIG="$DEFAULT_CONFIG"
    while [ $# -gt 0 ]; do
      case "$1" in
        --config) need_value "$1" $#; CONFIG="$2"; shift 2 ;;
        *) fail "未知参数：$1" ;;
      esac
    done
    if [ "$MODE" = run ]; then run_loop "$CONFIG"; else poll_once "$CONFIG"; fi
    ;;
  -h|--help|'') usage ;;
  *) fail "未知模式：$MODE" ;;
esac
