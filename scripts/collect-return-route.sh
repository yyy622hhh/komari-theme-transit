#!/usr/bin/env bash
# 三网回程线路采集：在节点上跑 traceroute，把判定证据写回 Komari 的节点 tags。
#
# 主题不能自己采集——浏览器没有原始套接字，Komari 的 Ping 任务也只有
# icmp/tcp/http。这个脚本补上采集那一段，输出格式见 src/utils/routeTag.ts。
#
# 方向说明：「回程」是相对国内用户定义的（国内用户 → 节点是去程，节点 → 国内
# 用户是回程），所以从节点向国内三网测速点做 traceroute 测到的正是回程。目标地
# 址与 src/utils/topologyPresets.ts 的九个入口预设同源。
#
# 用法：
#   ./collect-return-route.sh                          # 只打印标签，不写回
#   ./collect-return-route.sh --city sh                # 换用上海三网
#   ./collect-return-route.sh --push --url https://status.example.com \
#       --uuid <节点UUID> --key-file /root/.config/transit/api-key
#   省略 --key-file 时从终端隐藏输入密钥；不接受 --key 或 KOMARI_API_KEY。
#
# 依赖：traceroute（ICMP 模式需 root）；--push 另需 python3。
# 建议 cron：每天一次足够，回程通常几周才变一次。
#   0 4 * * * /opt/transit/collect-return-route.sh --push --url https://status.example.com --uuid ... --key-file /root/.config/transit/api-key >/dev/null 2>&1

set -uo pipefail

CITY="bj"
PUSH=0
KOMARI_URL="${KOMARI_URL:-}"
NODE_UUID="${KOMARI_UUID:-}"
KEY_FILE=""
MAX_HOPS=30

# Reject legacy credentials before starting any child process. Parsing/shift cannot
# erase an existing secret from the OS argument list or inherited environment.
[ -z "${KOMARI_API_KEY+x}" ] || {
  echo "不再接受 KOMARI_API_KEY；请改用 --key-file 或终端隐藏输入，并考虑轮换旧密钥。" >&2
  exit 1
}

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# 取值型参数缺少取值时必须当场报错退出。脚本用的是 `set -uo pipefail`（没有 -e），
# 而 bash 的 `shift 2` 在只剩一个参数时不会移动、只返回非零——那个返回值被忽略后
# while 就永远转下去了。`./collect-return-route.sh --city` 这种手误会直接挂死。
need_value() {
  [ "$2" -ge 2 ] || { echo "参数 $1 缺少取值" >&2; exit 1; }
}

while [ $# -gt 0 ]; do
  case "$1" in
    --city) need_value "$1" $#; CITY="$2"; shift 2 ;;
    --push) PUSH=1; shift ;;
    --url) need_value "$1" $#; KOMARI_URL="$2"; shift 2 ;;
    --uuid) need_value "$1" $#; NODE_UUID="$2"; shift 2 ;;
    --key|--key=*) echo "不再接受 --key；请改用 --key-file 或终端隐藏输入，并考虑轮换旧密钥。" >&2; exit 1 ;;
    --key-file) need_value "$1" $#; KEY_FILE="$2"; shift 2 ;;
    --max-hops) need_value "$1" $#; MAX_HOPS="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数，请使用 --help 查看用法。" >&2; exit 1 ;;
  esac
done

# 三网测速点。与 oneclickvirt/nt3 和 zhanghanyun/backtrace 用的是同一份地址表。
case "$CITY" in
  bj) CT_IP=219.141.140.10; CU_IP=202.106.195.68; CM_IP=221.179.155.161 ;;
  sh) CT_IP=202.96.209.133; CU_IP=210.22.97.1;    CM_IP=211.136.112.200 ;;
  gz) CT_IP=58.60.188.222;  CU_IP=210.21.196.6;   CM_IP=120.196.165.24 ;;
  *) echo "--city 只支持 bj / sh / gz，收到：$CITY" >&2; exit 1 ;;
esac

command -v traceroute >/dev/null 2>&1 || {
  echo "缺少 traceroute。Debian/Ubuntu: apt install -y traceroute；RHEL 系: yum install -y traceroute" >&2
  exit 1
}

# 跳点 IPv4 -> 骨干网 ASN。规则来自 oneclickvirt/backtrace 的 bk/ipv4_asn.go，
# 但这里按整段比对：上游的裸字符串前缀会把 111.240.* 误判成 AS9808、把电信广东
# 的 61.140.* 误判成联通 AS10099。
asn_of() {
  local ip="$1" o1 o2 o3
  IFS=. read -r o1 o2 o3 _ <<<"$ip" || return
  case "$o1.$o2" in
    59.43) echo 4809 ;;
    202.97) echo 4134 ;;
    218.105|210.51) echo 9929 ;;
    202.77|43.252|61.14) echo 10099 ;;
    219.158) echo 4837 ;;
    221.183|111.24) echo 9808 ;;
    69.194|203.22) echo 23764 ;;
    # 移动 CMIN2(AS58807) 的地址段嵌在 CMI(AS58453) 的 223/8 前缀里，必须先按
    # 第三段细分，剩下的才算 CMI。
    223.118) [ "$o3" = "32" ] && echo 58807 || echo 58453 ;;
    223.120) [ "$o3" -ge 128 ] 2>/dev/null && echo 58807 || echo 58453 ;;
    223.119)
      case "$o3" in
        8|9|1[0-5]|2[6-9]|3[2-7]|74|75|88|89|100|252|253) echo 58807 ;;
        *) echo 58453 ;;
      esac ;;
    223.121) echo 58453 ;;
    *) : ;;
  esac
}

# 跑一次 traceroute，按跳序输出认得出的骨干 ASN（认不出的跳直接跳过——判定只
# 看目标 ASN 的先后与出现次数，中间隔了几跳不影响结论）。
trace_asns() {
  local target="$1" out
  # 优先 ICMP：国内测速点普遍过滤 UDP 探测包。ICMP 模式需要 root。
  out=$(traceroute -I -n -q 1 -w 1 -m "$MAX_HOPS" "$target" 2>/dev/null) \
    || out=$(traceroute -n -q 1 -w 1 -m "$MAX_HOPS" "$target" 2>/dev/null) \
    || return 1

  local asns=() asn
  while read -r ip; do
    asn=$(asn_of "$ip")
    [ -n "$asn" ] && asns+=("$asn")
  done < <(echo "$out" | grep -oE '^[[:space:]]*[0-9]+[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | awk '{print $2}')

  local IFS=.
  echo "${asns[*]:-}"
}

echo "正在采集${CITY}三网回程（每家最多 ${MAX_HOPS} 跳）…" >&2
CT_ASNS=$(trace_asns "$CT_IP") || CT_ASNS=""
CU_ASNS=$(trace_asns "$CU_IP") || CU_ASNS=""
CM_ASNS=$(trace_asns "$CM_IP") || CM_ASNS=""

TAG="transit-route:ct=${CT_ASNS},cu=${CU_ASNS},cm=${CM_ASNS}@$(date +%s)"
echo "$TAG"

[ "$PUSH" -eq 1 ] || exit 0

# 三家一个骨干跳都没认出来，更可能是本机 traceroute 被拦或网络在抖，而不是回程
# 真的变成了「未见骨干」。这种结果不写回，免得一次抖动把上次的好结果覆盖掉。
if [ -z "$CT_ASNS" ] && [ -z "$CU_ASNS" ] && [ -z "$CM_ASNS" ]; then
  echo "三家均未识别到骨干跳点，判为采集失败，本次不写回。" >&2
  exit 1
fi

[ -n "$KOMARI_URL" ] || { echo "--push 需要 --url" >&2; exit 1; }
[ -n "$NODE_UUID" ] || { echo "--push 需要 --uuid" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "--push 需要 python3" >&2; exit 1; }

# 读回现有 tags、去掉旧的 transit-route 条目、把新条目接上去再写回。
# 必须先读后写：admin:editClient 是按字段覆盖的，直接写会抹掉运营者自己的标签。
# 隔离模式禁止从当前目录、用户 site-packages 或 PYTHON* 环境变量加载模块。
# sudo 运行时也不能让可写工作目录中的同名模块在凭据校验之前执行。
KOMARI_URL="$KOMARI_URL" NODE_UUID="$NODE_UUID" TRANSIT_KEY_FILE="$KEY_FILE" TAG="$TAG" python3 -I - <<'PY'
import getpass, json, os, ssl, stat, sys, urllib.error, urllib.parse, urllib.request, warnings

def endpoint(value):
    # urlsplit silently removes some control characters; reject them first.
    if any(ord(char) <= 32 or ord(char) >= 127 for char in value) or any(char in value for char in "\\?#"):
        raise SystemExit("--url 必须是 HTTPS 源地址，不能包含凭据、路径、查询参数或控制字符。")
    try:
        parsed = urllib.parse.urlsplit(value)
        valid = (parsed.scheme == "https" and parsed.hostname
                 and parsed.username is None and parsed.password is None
                 and parsed.path in ("", "/") and not parsed.netloc.endswith(":")
                 and (parsed.port is None or 1 <= parsed.port <= 65535))
    except ValueError:
        valid = False
    if not valid:
        raise SystemExit("--url 必须是 HTTPS 源地址，不能包含凭据、路径、查询参数或控制字符。")
    return urllib.parse.urlunsplit(("https", parsed.netloc, "", "", ""))

def read_key(filename):
    if filename:
        # Validate the opened descriptor, not an earlier path stat (TOCTOU).
        # NONBLOCK prevents a FIFO from hanging before the regular-file check.
        try:
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
            with os.fdopen(os.open(filename, flags), "rb") as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) not in (0o400, 0o600)):
                    raise SystemExit("密钥文件必须由当前运行用户所有，且为权限 0400/0600 的普通文件。")
                raw = stream.read(4097)
            if len(raw) > 4096:
                raise SystemExit("密钥文件过大。")
            key = raw.decode("ascii").rstrip("\r\n")
        except (OSError, UnicodeError, AttributeError):
            raise SystemExit("无法安全读取密钥文件；请检查文件、属主及权限，不允许符号链接。")
    else:
        try:
            with warnings.catch_warnings():
                # getpass must never fall back to echoed/non-terminal stdin.
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("Komari API Key（隐藏输入）: ")
        except (getpass.GetPassWarning, EOFError, OSError, KeyboardInterrupt):
            raise SystemExit("无法从终端安全读取密钥；无人值守运行请使用 --key-file。")
    if not key or len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise SystemExit("密钥必须是非空的单行 ASCII 内容，不能包含空格或控制字符。")
    return key

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        raise SystemExit("写回端点返回重定向，已停止；请配置最终 HTTPS 源地址。")

    # Handle 308 explicitly even on older Python versions, before parsing Location.
    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

def rpc(opener, base, key, method, params):
    body = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1}).encode()
    request = urllib.request.Request(f"{base}/api/rpc2", data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
    })
    with opener.open(request, timeout=20) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or payload.get("error"):
        # A server/proxy error may echo Authorization; do not print its contents.
        raise SystemExit(f"{method} 失败：服务端返回错误或无效响应。")
    return payload.get("result")

def main():
    base = endpoint(os.environ["KOMARI_URL"])
    key = read_key(os.environ["TRANSIT_KEY_FILE"])
    uuid = os.environ["NODE_UUID"]
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    client = rpc(opener, base, key, "admin:getClient", {"uuid": uuid})
    if not isinstance(client, dict):
        raise SystemExit("admin:getClient 未返回节点对象，已停止写回。")

    kept = [t.strip() for t in str(client.get("tags") or "").split(";")
            if t.strip() and not t.strip().lower().startswith("transit-route:")]
    kept.append(os.environ["TAG"])
    rpc(opener, base, key, "admin:editClient", {"uuid": uuid, "tags": ";".join(kept)})
    print("已写回节点回程标签。", file=sys.stderr)

try:
    main()
except urllib.error.HTTPError as error:
    raise SystemExit(f"写回失败：HTTP {error.code}（检查 HTTPS 地址及密钥）")
except (OSError, ValueError, TypeError, urllib.error.URLError):
    raise SystemExit("写回失败：连接、证书校验或响应异常；未输出原始错误以保护凭据。")
PY
