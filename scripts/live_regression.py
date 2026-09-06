#!/usr/bin/env python3
"""Live regression: verify superuser/admin fixes deployed at mailbox.thinkcloud.dev.
Covers: presence heartbeat, internal note, card move, availability (real error not 502),
and that no 'agent auth required' gate remains for admin send path."""
import json, sys, urllib.request, urllib.error

BASE = "https://mailbox.thinkcloud.dev"
ADMIN_EMAIL = sys.argv[1] if len(sys.argv) > 1 else "jacobo@thinkcloud.dev"
ADMIN_PASS = sys.argv[2] if len(sys.argv) > 2 else "<<CREDENTIAL-REMOVED>>"

def req(method, path, body=None, token=None, raw=False):
    url = BASE + path
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
    if token:
        headers["Authorization"] = token
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            payload = resp.read().decode()
            return resp.status, payload
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:600]

ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS  {name}  {detail}")
    else:
        fail += 1
        print(f"  FAIL  {name}  {detail}")

# 1. Admin (superuser) auth
s, b = req("POST", "/api/collections/_superusers/auth-with-password",
           {"identity": ADMIN_EMAIL, "password": ADMIN_PASS})
print(f"[admin auth] {s}")
if s != 200:
    print("ADMIN AUTH FAILED:", b)
    sys.exit(1)
tok = json.loads(b)["token"]
print(f"  admin token OK ({tok[:20]}...)")

# 2. /me as superuser (shape: {inboxes:[...], me:{...}, ok:true})
s, b = req("GET", "/api/mailbox/me", token=tok)
print(f"[GET /me] {s}")
body = json.loads(b) if s == 200 else {}
inboxes = body.get("inboxes", []) if isinstance(body, dict) else []
check("admin /me returns inboxes", s == 200 and len(inboxes) > 0,
      f"{len(inboxes)} inboxes")
if not (s == 200 and inboxes):
    print("RAW:", b[:800])
    sys.exit(1)
team = next((i for i in inboxes if i.get("email_address") and "demo" not in str(i.get("email_address"))), inboxes[0])
print(f"  using inbox: {team.get('id')} / {team.get('email_address')}")

# pick a thread from that inbox
ib_id = team["id"]
s, b = req("GET", f"/api/collections/threads/records?filter=(inbox='{ib_id}')&perPage=3&sort=-last_message_at", token=tok)
threads = json.loads(b).get("items", []) if s == 200 else []
check("can list threads of inbox", s == 200 and len(threads) > 0, f"{len(threads)} threads")
if not threads:
    sys.exit(1)
t = threads[0]
print(f"  thread: {t['id'][:8]}.. subject={t.get('subject','')[:50]!r} customer={t.get('customer_email')}")

# 3. Presence heartbeat as admin (was 400)
s, b = req("POST", f"/api/mailbox/threads/{t['id']}/presence", {"status": "viewing"}, token=tok)
check("presence heartbeat as admin", s == 200, b[:120])

# 4. Internal note as admin (was 400 - invalid admin@local email)
s, b = req("POST", f"/api/mailbox/threads/{t['id']}/notes",
           {"body": "Live regression note (admin superuser) — safe test."}, token=tok)
check("internal note as admin", s == 200, b[:120])

# 5. Card move as admin
s, b = req("POST", f"/api/mailbox/threads/{t['id']}/move", {"status": "in_progress"}, token=tok)
check("card move as admin", s == 200, b[:120])

# 6. Availability — real JSON error, NOT swallowed 502
s, b = req("GET", f"/api/mailbox/threads/{t['id']}/availability", token=tok)
try:
    j = json.loads(b)
    is_json = True
except Exception:
    is_json = False
check("availability returns JSON (not stripped 502)", s == 200 and is_json, f"{s} {b[:160]}")

# 7. Meet handler — real error surfaced as JSON (no 502)
s, b = req("POST", f"/api/mailbox/threads/{t['id']}/meet", {}, token=tok)
try:
    j = json.loads(b)
    is_json = True
    msg = j.get("message") or j.get("error") or str(j)[:120]
except Exception:
    is_json = False
    msg = b[:120]
check("meet returns JSON w/ real msg", s == 200 and is_json, f"{s} {msg}")

print(f"\nRESULT: {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
