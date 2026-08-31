"""Execute the collector's actual Python payload; replace only network I/O.

The real urllib opener, redirect/error handlers, TLS context, credential file
operations and optional terminal input run unchanged. No listener or root needed.
"""
import http.client
import io
import json
import os
import pty
import select
import socket
import ssl
import subprocess
import sys
import time
import urllib.request

assert sys.flags.isolated == 1, "HTTP and terminal fixtures must preserve isolated Python startup"

KEY = "TRANSIT-FAKE-ADMIN-KEY-NOT-A-REAL-CREDENTIAL"


def terminal_test():
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("bash", ["bash"] + sys.argv[2:])
    output = b""
    sent = False
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not select.select([fd], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(fd, 8192)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
            if not sent and b"Komari API Key" in output:
                # getpass emits its prompt only after disabling terminal echo.
                os.write(fd, (KEY + "\n").encode())
                sent = True
        else:
            os.kill(pid, 9)
            raise AssertionError("terminal test timed out")
        _, status = os.waitpid(pid, 0)
        assert sent and status == 0, output.decode(errors="replace")
        assert KEY.encode() not in output, "terminal echoed credential"
        print("terminal input remained hidden")
    finally:
        os.close(fd)


if sys.argv[1:] and sys.argv[1] == "--terminal-test":
    terminal_test()
    sys.exit(0)

scenario = os.environ["COLLECTOR_SCENARIO"]
observed = {"requests": [], "verified_tls": False, "clean_processes": True, "clean_environment": True}


def forbid_socket(*args, **kwargs):
    raise AssertionError("unexpected real network access")


socket.socket = forbid_socket
# urllib also discovers macOS system proxies outside the environment. Keep this
# fixture isolated from host networking while leaving production handlers intact.
urllib.request.getproxies = lambda: {}


class ResponseSocket:
    def __init__(self, body):
        self.body = body

    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.body)


class FakeHTTPSConnection:
    def __init__(self, host, **kwargs):
        context = kwargs["context"]
        observed["verified_tls"] = context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
        assert observed["verified_tls"], "TLS verification must remain enabled"
        self.sock = None

    def set_debuglevel(self, level):
        pass

    def set_tunnel(self, *args, **kwargs):
        raise AssertionError("test proxy must be disabled")

    def request(self, method, url, body, headers, **kwargs):
        params = json.loads(body)
        observed["requests"].append({
            "method": method, "url": url, "rpc": params["method"], "params": params["params"],
            "authorized": any(k.lower() == "authorization" and v == "Bearer " + KEY for k, v in headers.items()),
        })
        args = subprocess.check_output(["ps", "-p", str(os.getpid()) + "," + str(os.getppid()), "-o", "command="])
        observed["clean_processes"] = observed["clean_processes"] and KEY.encode() not in args
        observed["clean_environment"] = not any(KEY in value for value in os.environ.values())
        if scenario == "bad-certificate":
            raise ssl.SSLCertVerificationError(KEY)

    def getresponse(self):
        status, reason, extra = 200, "OK", ""
        result = {"tags": "operator-tag;transit-route:ct=4134,cu=,cm=@1"}
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": result})
        if scenario.startswith("redirect-"):
            _, code, scheme = scenario.split("-")
            status = int(code)
            extra = "Location: " + scheme + "://other.invalid/capture\r\n"
        elif scenario == "rpc-error":
            body = json.dumps({"error": {"message": KEY}})
        elif scenario == "http-error":
            status, reason, body = 500, KEY, KEY
        elif scenario == "invalid-json":
            body = KEY
        elif scenario == "missing-client":
            body = '{"result": null}'
        elif scenario == "echo-tags":
            body = json.dumps({"result": {"tags": KEY}})
        encoded = body.encode()
        wire = ("HTTP/1.1 %d %s\r\n%sContent-Length: %d\r\n\r\n" % (status, reason, extra, len(encoded))).encode() + encoded
        response = http.client.HTTPResponse(ResponseSocket(wire))
        response.begin()
        return response

    def close(self):
        pass


http.client.HTTPSConnection = FakeHTTPSConnection
if scenario == "wrong-owner":
    uid = os.geteuid()
    os.geteuid = lambda: uid + 1
elif scenario == "no-terminal":
    os.setsid()

try:
    # The shell passes its unchanged here-document to this Python test process.
    exec(compile(sys.stdin.read(), "collect-return-route.sh:embedded-python", "exec"), {"__name__": "__main__"})
finally:
    with open(os.environ["COLLECTOR_OBSERVED"], "w") as output:
        json.dump(observed, output)
