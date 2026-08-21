#!/usr/bin/env bash
# Transit 三网回程节点助手。
#
# 它不监听端口，也不接受命令、IP 或 traceroute 参数。服务端只能返回一次性任务 ID
# 和 beijing/shanghai/guangzhou 三个固定城市之一，实际目标由本机的
# collect-return-route.sh 选择。助手复用本节点现有 Komari Agent token，通过 HTTPS
# 主动轮询伴生插件，因此节点无需开放任何入站端口。

set -uo pipefail

VERSION="1.1.2"
DEFAULT_CONFIG="/etc/transit-route-probe.conf"
INSTALL_DIR="/usr/local/libexec/transit-route-probe"
SERVICE_NAME="transit-route-probe"
SERVICE_USER="transit-route-probe"
POLL_SECONDS=15

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
  case "$1" in
    https://*) : ;;
    http://*) [ "${ALLOW_INSECURE_HTTP:-0}" = "1" ] || return 1 ;;
    *) return 1 ;;
  esac
  [[ "$1" != *[$'\r\n\t\" ']* ]]
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
  umask 077
  {
    printf 'url = "%s"\n' "$url"
    printf 'silent\nshow-error\n'
    printf 'connect-timeout = 10\nmax-time = 25\n'
    printf 'header = "User-Agent: Transit-Route-Probe/%s"\n' "$VERSION"
  } >"$output"
}

post_result() {
  local job_id="$1" field="$2" value="$3" runtime_dir="$4"
  local request_config="$runtime_dir/result.curl" response="$runtime_dir/result.body"
  make_curl_config "$ENDPOINT/api/transit-route-probe/v1/result?token=$TOKEN" "$request_config"
  local status
  status=$(curl --config "$request_config" \
    --request POST \
    --header 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "job_id=$job_id" \
    --data-urlencode "$field=$value" \
    --output "$response" \
    --write-out '%{http_code}') || return 1
  [ "$status" = "200" ] || {
    echo "Transit Route Probe: 提交结果失败（HTTP $status）" >&2
    return 1
  }
}

poll_once() {
  local config="$1"
  read_config "$config"
  command -v curl >/dev/null 2>&1 || fail "缺少 curl"
  command -v timeout >/dev/null 2>&1 || fail "缺少 timeout（coreutils）"

  local runtime_dir="${RUNTIME_DIRECTORY:-/tmp/transit-route-probe}"
  mkdir -p "$runtime_dir"
  chmod 700 "$runtime_dir"
  local request_config="$runtime_dir/poll.curl" response="$runtime_dir/poll.body"
  make_curl_config "$ENDPOINT/api/transit-route-probe/v1/poll?token=$TOKEN" "$request_config"

  local status
  status=$(curl --config "$request_config" --output "$response" --write-out '%{http_code}') || {
    echo "Transit Route Probe: 无法连接 Komari" >&2
    return 0
  }
  case "$status" in
    204) return 0 ;;
    401|403)
      echo "Transit Route Probe: Agent token 未通过认证（HTTP $status）" >&2
      return 0
      ;;
    404)
      echo "Transit Route Probe: Komari 尚未安装或启用伴生插件" >&2
      return 0
      ;;
    200) : ;;
    *)
      echo "Transit Route Probe: 轮询失败（HTTP $status）" >&2
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

  local collector="$INSTALL_DIR/collect-return-route.sh" tag
  [ -x "$collector" ] || {
    post_result "$job_id" error internal-error "$runtime_dir" || true
    return 0
  }
  tag=$(timeout 150 "$collector" --city "$city_code" 2>"$runtime_dir/collector.log") || {
    post_result "$job_id" error probe-failed "$runtime_dir" || true
    return 0
  }
  [[ "$tag" =~ ^transit-route:ct=[0-9.]*,cu=[0-9.]*,cm=[0-9.]*@[0-9]{10,13}$ ]] || {
    post_result "$job_id" error probe-failed "$runtime_dir" || true
    return 0
  }
  local chains=${tag#transit-route:}
  chains=${chains%@*}
  [ "$chains" != "ct=,cu=,cm=" ] || {
    post_result "$job_id" error probe-failed "$runtime_dir" || true
    return 0
  }
  post_result "$job_id" tag "$tag" "$runtime_dir" || true
}

run_loop() {
  local config="$1"
  while :; do
    poll_once "$config"
    sleep "$POLL_SECONDS" &
    wait $! || exit 0
  done
}

install_helper() {
  [ "$(id -u)" -eq 0 ] || fail "install 需要 root"
  command -v systemctl >/dev/null 2>&1 || fail "当前系统没有 systemd"
  command -v curl >/dev/null 2>&1 || fail "缺少 curl，安装器不会自动安装系统软件"
  command -v timeout >/dev/null 2>&1 || fail "缺少 timeout（coreutils），安装器不会自动安装系统软件"
  local endpoint="" token="" token_file="" allow_insecure=0
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --endpoint) need_value "$1" $#; endpoint="$2"; shift 2 ;;
      --token) need_value "$1" $#; token="$2"; shift 2 ;;
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
  valid_token "$token" || fail "--token 不是受支持的 Agent token 格式"

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
  {
    printf 'endpoint=%s\n' "$endpoint"
    printf 'token=%s\n' "$token"
    printf 'allow_insecure_http=%s\n' "$allow_insecure"
  } >"$DEFAULT_CONFIG"
  chown root:"$SERVICE_USER" "$DEFAULT_CONFIG"
  chmod 0640 "$DEFAULT_CONFIG"

  local service_file="/etc/systemd/system/$SERVICE_NAME.service"
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
  } >"$service_file"
  chmod 0644 "$service_file"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME.service"
  echo "Transit Route Probe 已安装。查看状态：systemctl status $SERVICE_NAME" >&2
}

uninstall_helper() {
  [ "$(id -u)" -eq 0 ] || fail "uninstall 需要 root"
  systemctl disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service" "$DEFAULT_CONFIG"
  rm -rf "$INSTALL_DIR"
  systemctl daemon-reload
  echo "Transit Route Probe 已卸载；专用系统用户仍保留，可手动删除。" >&2
}

MODE=${1:-}
case "$MODE" in
  install) install_helper "$@" ;;
  uninstall) uninstall_helper ;;
  run|once)
    shift
    CONFIG="$DEFAULT_CONFIG"
    while [ $# -gt 0 ]; do
      case "$1" in
        --config) need_value "$1" $#; CONFIG="$2"; shift 2 ;;
        *) fail "未知参数：$1" ;;
      esac
    done
    [ "$MODE" = "run" ] && run_loop "$CONFIG" || poll_once "$CONFIG"
    ;;
  -h|--help|'') usage ;;
  *) fail "未知模式：$MODE" ;;
esac
