# Chay Muse Bridge 24/7 tren Ubuntu

Bridge o repo nay: Node 18+, khong dependency, chay local o cong 8797,
luu tin nhan vao `messages.jsonl`, token board luu vao `token.txt` (ca hai
da gitignore, restart khong mat). Muse chay tren cloud Meta khong doc duoc
localhost, nen can tunnel Cloudflare de expose ra ngoai.

## 1. Chuan bi tren PC

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo apt update && sudo apt install -y curl git
# Node 18+ (kiem tra: node --version)
# Cai cloudflared theo huong dan chinh thuc cua Cloudflare
```

Vao BIOS bat `Restore on AC Power Loss` de mat dien roi co dien lai PC tu bat.
Dung day LAN neu duoc.

Clone repo ve PC, tao `.env` tu `.env.example`, dien
`TELEGRAM_BOT_TOKEN` va `TELEGRAM_CHAT_ID`. Khong commit `.env`.

## 2. Cai 2 service systemd

Ca hai file o thu muc nay deu dung gia tri mac dinh:

- `User=martin`
- `WorkingDirectory=/home/martin/muse2muse`

Sua lai cho dung username va duong dan clone that tren PC cua Martin
truoc khi cai.

```bash
sudo cp deploy/ubuntu/muse-bridge.service /etc/systemd/system/
sudo cp deploy/ubuntu/muse-cloudflared.service /etc/systemd/system/
sudo cp deploy/ubuntu/muse-bridge-health.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/muse-bridge-health.sh
sudo systemctl daemon-reload
sudo systemctl enable --now muse-bridge.service muse-cloudflared.service
```

Phai co ca 2 service: bridge chet thi systemd tu restart, tunnel chet thi
Muse cloud khong mo duoc board du bridge van song.

File env dung chung cho service, dat o `/etc/muse-bridge.env`
(chmod 600), vi du:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
PORT=8797
HOST=127.0.0.1
```

## 3. Healthcheck tu phuc hoi

Cho script chay moi 5 phut bang cron:

```text
*/5 * * * * /usr/local/bin/muse-bridge-health.sh
```

Script goi `http://127.0.0.1:8797/health`, fail thi restart
`muse-bridge.service` va bao cho Martin qua Telegram neu da dien token.

## 4. Kiem tra

```bash
sudo systemctl status muse-bridge.service muse-cloudflared.service
journalctl -u muse-bridge.service -f
curl -fsS http://127.0.0.1:8797/health
```

Lay URL tunnel tu log cua cloudflared, mo mailbox
`https://<tunnel-host>/b/<BRIDGE_TOKEN>`, gui 1 tin test tu Telegram
roi kiem tra co len board khong, va nguoc lai.

Sau do reboot that 1 lan (`sudo reboot`), doi 2 phut roi kiem tra lai
ca 2 service van `active (running)`.

## Luu y

- Chi chay 1 poller Telegram tai 1 thoi diem. Chay 2 poller cung luc
  se gap loi `getUpdates 409`.
- `messages.jsonl` va `token.txt` nam trong thu muc repo, backup rieng.
  Lo token board thi xoa `token.txt` roi restart de tao token moi.
- Bot Telegram chi nhan tin trong dung `TELEGRAM_CHAT_ID` cua Martin.
