```console
$ ssh guest@0jre.dev
Welcome to 0jre's machine — Ubuntu 24.04 LTS (GNU/Linux)
Last login: never. He's always here.

guest@0jre:~$ whoami
jre — builder, Brasil. Hiring: open.

guest@0jre:~$ cat /etc/motd
:|

guest@0jre:~$ ls ~/projects/
Alladin/      clubvision/   memecoins/    runne/        vega-agent/

guest@0jre:~$ for p in ~/projects/*/; do head -1 "$p/DESCRIPTION"; done
==> Alladin <==
    Python backend for Solana multi-agent trading research —
    paper execution, deterministic risk controls, auditable decisions.

==> clubvision <==
    Plataforma completa para comunidade FiveM (GTA V RP): site,
    bot de Discord e painel administrativo. Projeto de estudo, 2023.

==> memecoins <==
    MCP server for Solana memecoin creation by AI agents — launch SPL
    tokens onto Raydium, Orca or Meteora. 100% logic, no UI.

==> runne <==
    Code hosting forge. MIT licensed.

==> vega-agent <==
    Agent forge — gitrun, desktop app, multi-provider adapters.

guest@0jre:~$ cat ~/.config/stack
langs:      TypeScript · Python · Rust · Go
agents:     MCP · multi-agent orchestration · LLM tooling
chain:      Solana · SPL · Raydium · Meteora
infra:      AWS · Docker · Linux

guest@0jre:~$ stats --github
repos: 4 public   followers: 17   commits: yes

guest@0jre:~$ contact
mail:  jc7104484@gmail.com
gh:    github.com/0jre

guest@0jre:~$ exit
Connection to 0jre.dev closed.
```
