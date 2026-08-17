#!/usr/bin/env python3
"""测试机远程执行小工具（凭据从 .secrets/testenv.env 读，不进命令行）。

用法：
    python .secrets/rsh.py '<remote shell command>'
    python .secrets/rsh.py --put <local> <remote>

放在 .secrets/ 下是因为该目录已被 .gitignore 忽略：这个脚本本身不含密码，
但它的存在只对配了凭据的机器有意义，跟着凭据一起留在仓库外最省事。
"""
import os
import sys
import pathlib

import paramiko

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_env():
    env = {}
    for line in (ROOT / ".secrets" / "testenv.env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def connect(env):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        env["VC_TEST_HOST"],
        port=int(env.get("VC_TEST_PORT", 22)),
        username=env["VC_TEST_USER"],
        password=env["VC_TEST_PASSWORD"],
        timeout=20,
        banner_timeout=30,
    )
    return c


def main():
    env = load_env()
    args = sys.argv[1:]
    if not args:
        print("用法: rsh.py '<cmd>' | rsh.py --put <local> <remote>", file=sys.stderr)
        return 2

    c = connect(env)
    try:
        if args[0] == "--put":
            local, remote = args[1], args[2]
            sftp = c.open_sftp()
            sftp.put(local, remote)
            sftp.close()
            print(f"已上传 {local} -> {remote}")
            return 0

        cmd = args[0]
        # 用 login shell，保证 ~/.cargo/bin 等 PATH 生效
        stdin, stdout, stderr = c.exec_command(f"bash -lc {shell_quote(cmd)}", timeout=None)
        stdin.close()
        chan = stdout.channel
        # 合并流式输出，避免长构建看起来像卡死
        while True:
            if chan.recv_ready():
                sys.stdout.write(chan.recv(65536).decode("utf-8", "replace"))
                sys.stdout.flush()
            if chan.recv_stderr_ready():
                sys.stdout.write(chan.recv_stderr(65536).decode("utf-8", "replace"))
                sys.stdout.flush()
            if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
                break
        rc = chan.recv_exit_status()
        print(f"\n[rc={rc}]")
        return rc
    finally:
        c.close()


def shell_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    sys.exit(main())
