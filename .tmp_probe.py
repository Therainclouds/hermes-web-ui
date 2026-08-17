import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('6.6.6.47', username='root', password='123456', timeout=10)

cmds = [
    # 部署目录结构
    "ls -la /opt/hermes-web-ui/ | head -20",
    # 是否有更新记录/日志
    "ls -la /home/hermesui/.hermes-web-ui/ 2>/dev/null | head -20",
    "find /home/hermesui -maxdepth 2 -name '*.log' -newer /opt/hermes-web-ui/package.json 2>/dev/null | head -5",
    # 服务端进程
    "ps aux | grep -E 'hermes|node' | grep -v grep | head -5",
    # 检查 update 状态文件
    "cat /home/hermesui/.hermes-web-ui/update-state.json 2>/dev/null | head -c 800",
    "cat /opt/hermes-web-ui/UPDATE_INFO 2>/dev/null; cat /opt/hermes-web-ui/.update-source 2>/dev/null",
]
for cmd in cmds:
    stdin, stdout, stderr = c.exec_command(cmd)
    print('>>>', cmd[:90])
    out = stdout.read().decode('utf-8', errors='replace')
    print(out if out.strip() else '(empty)')
    err = stderr.read().decode('utf-8', errors='replace').strip()
    if err and 'No such' not in err: print('ERR:', err[:200])
    print()

c.close()
