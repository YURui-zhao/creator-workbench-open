#!/usr/bin/env python3
"""全栈达人工作台一键启动脚本（后端 Node.js + better-sqlite3，前端 Vite + React）"""
import glob
import os
import shutil
import signal
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

# 本机没有全局 Node 时，按顺序尝试这些位置的 Node（存在即用）
NODE_CANDIDATES = [
    # 显式指定优先：NODE_BINARY=/path/to/node python3 start.py
    os.environ.get("NODE_BINARY", ""),
    # 常见全局安装位置（Homebrew Intel / Apple Silicon、系统、nvm）
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
    # 项目内便携运行时（node/bin/node 或 node-vXX-darwin-*/bin/node）
    os.path.join(ROOT, "node", "bin", "node"),
    *sorted(glob.glob(os.path.join(ROOT, "node-v*-darwin-*", "bin", "node"))),
    *sorted(glob.glob("/private/tmp/nodejs/node-v*-darwin-*/bin/node")),
    *sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node")), reverse=True),
]

NODE_INSTALL_HINT = """
[start] 未找到 Node.js（版本需 >= 18）。
[start] 三种解决方式任选其一：
[start]   1) 安装 Node.js：brew install node
[start]   2) 使用便携运行时（macOS Apple Silicon）：
[start]        mkdir -p /private/tmp/nodejs && cd /private/tmp/nodejs
[start]        curl -O https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz
[start]        tar -xzf node-v22.14.0-darwin-arm64.tar.gz
[start]   3) 已有 Node 但不在 PATH 时，指定路径运行：
[start]        NODE_BINARY=/path/to/node python3 start.py
""".strip()


def find_node():
    """查找可用的 Node：先看 PATH，再按候选列表（跳过不存在的路径）"""
    node = shutil.which("node")
    if node:
        return node
    for candidate in NODE_CANDIDATES:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def main():
    node = find_node()
    if node is None:
        print(NODE_INSTALL_HINT)
        sys.exit(1)

    node_dir = os.path.dirname(node)
    env = dict(os.environ)
    env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")

    backend = subprocess.Popen([node, "server.js"], cwd=os.path.join(ROOT, "backend"))
    frontend = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=os.path.join(ROOT, "frontend"),
        env=env,
    )

    def shutdown(_signum=None, _frame=None):
        for proc in (backend, frontend):
            if proc.poll() is None:
                proc.terminate()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print("=" * 48)
    print("  达人投放工作台已启动")
    print(f"  后端 API : http://localhost:3001 (Node.js: {node})")
    print("  前端页面 : http://localhost:5173 (Vite + React)")
    print("  按 Ctrl+C 停止")
    print("=" * 48)

    try:
        backend.wait()
        frontend.wait()
    except KeyboardInterrupt:
        shutdown()
    finally:
        for proc in (backend, frontend):
            if proc.poll() is None:
                proc.terminate()


if __name__ == "__main__":
    main()
