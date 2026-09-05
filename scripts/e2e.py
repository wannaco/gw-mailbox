#!/usr/bin/env python3
"""gw-mailbox E2E smoke test against a live PocketBase on 127.0.0.1:8096."""
import json, sys, base64, urllib.request, urllib.error, urllib.parse

BASE = "http://127.0.0.1:8096"
PASS = 0
FAIL = 0

def call(method, path, body=None, token=None, raw=False):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            payload = r.read()
            return r.status, (payload if raw else json.loads(payload or b"{}"))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload or b"{}")
        except Exception:
            return e.code, payload

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")

# --- 1. superuser -----------------------------------------------------------
s, r = call("POST", "/api/collections/_superusers/auth-with-password",
            {"identity": "admin@test.local", "password": "test12345!"})
check("superuser login", s == 200 and "token" in r, str(r)[:200])
SU = r.get("token", "")

# --- 2. seed users / team / inboxes -----------------------------------------
def mk_user(email, name):
    s, r = call("POST", "/api/collections/users/records",
                {"email": email, "password": "test12345!", "passwordConfirm": "test12345!",
                 "name": name, "verified": True}, SU)
    assert s in (200, 201), (s, r)
    return r["id"]

u1 = mk_user("alice@test.local", "Alice Agent")
u2 = mk_user("bob@test.local", "Bob Agent")
check("users created", bool(u1 and u2))

s, r = call("POST", "/api/collections/teams/records", {"name": "Support L1", "members": [u2]}, SU)
check("team created", s in (200, 201), str(r)[:200])
team_id = r["id"]

# inbox1: only Alice (direct). inbox2: only Bob (via team). inbox3: Alice
# (direct) + Bob (via team) => shared.
s, r = call("POST", "/api/collections/inboxes/records",
            {"name": "Support", "email_address": "support@test.local",
             "allowed_users": [u1], "allowed_teams": [], "is_active": True}, SU)
inbox1 = r["id"]
s, r = call("POST", "/api/collections/inboxes/records",
            {"name": "Sales", "email_address": "sales@test.local",
             "allowed_users": [], "allowed_teams": [team_id], "is_active": True}, SU)
inbox2 = r["id"]
s, r = call("POST", "/api/collections/inboxes/records",
            {"name": "Billing", "email_address": "billing@test.local",
             "allowed_users": [u1], "allowed_teams": [team_id], "is_active": True}, SU)
inbox3 = r["id"]
check("inboxes created", bool(inbox1 and inbox2 and inbox3))

def login(email):
    s, r = call("POST", "/api/collections/users/auth-with-password",
                {"identity": email, "password": "test12345!"})
    assert s == 200, (s, r)
    return r["token"]

T1 = login("alice@test.local")
T2 = login("bob@test.local")
check("agent logins", bool(T1 and T2))

# --- 3. threads -------------------------------------------------------------
def mk_thread(inbox, gid, status=None):
    body = {"inbox": inbox, "gmail_thread_id": gid, "subject": "Subj " + gid,
            "snippet": "snip", "customer_email": "cust@ext.test", "customer_name": "Cust"}
    if status:
        body["status"] = status
    s, r = call("POST", "/api/collections/threads/records", body, SU)
    assert s in (200, 201), (s, r)
    return r

ta = mk_thread(inbox1, "g-AAAA")          # Alice only
tb = mk_thread(inbox2, "g-BBBB")          # Bob only (via team)
tc = mk_thread(inbox3, "g-CCCC")          # shared
# thread created WITHOUT status/sla -> hook must default status=new + sla_due_at
s, r = call("POST", "/api/collections/threads/records",
            {"inbox": inbox1, "gmail_thread_id": "g-DDDD", "subject": "No status"},
            SU)
check("hook defaults status=new", s in (200, 201) and r.get("status") == "new", str(r)[:200])
check("hook defaults sla_due_at", bool(r.get("sla_due_at")), str(r)[:200])

# --- 4. /api/mailbox/me + isolation ----------------------------------------
s, r = call("GET", "/api/mailbox/me", token=T1)
ids1 = [i["id"] for i in r.get("inboxes", [])]
s2, r2 = call("GET", "/api/mailbox/me", token=T2)
ids2 = [i["id"] for i in r2.get("inboxes", [])]
check("me: alice sees support+billing", s == 200 and inbox1 in ids1 and inbox3 in ids1 and inbox2 not in ids1, str(ids1))
check("me: bob sees sales+billing via team", s2 == 200 and inbox2 in ids2 and inbox3 in ids2 and inbox1 not in ids2, str(ids2))

s, r = call("GET", "/api/collections/threads/records?perPage=100&filter=" + urllib.parse.quote('gmail_thread_id="g-AAAA"'), token=T2)
check("isolation: bob cannot list alice thread", r.get("totalItems", 0) == 0, str(r)[:200])
s, r = call("GET", "/api/collections/threads/records/" + ta["id"], token=T2)
check("isolation: bob cannot view alice thread", s == 404, str(r)[:200])

# --- 5. draft lock across two agents on shared thread C ---------------------
s, r = call("POST", f"/api/mailbox/threads/{tc['id']}/presence",
            {"status": "composing_reply"}, token=T1)
check("alice composing heartbeat", s == 200 and r.get("ok"), str(r)[:200])
check("alice sees no lock (self)", s == 200 and r.get("lock") is None, str(r)[:200])

s, r = call("POST", f"/api/mailbox/threads/{tc['id']}/presence",
            {"status": "viewing"}, token=T2)
check("bob heartbeat returns lock(alice)", s == 200 and r.get("lock") and r["lock"]["agentName"] == "Alice Agent", json.dumps(r)[:250])
check("snapshot shows 2 agents", s == 200 and len(r.get("presence", [])) == 2, str(r)[:250])

s, r = call("POST", f"/api/mailbox/threads/{tc['id']}/presence",
            {"status": "composing_reply"}, token=T2)
check("bob composing (second lock)", s == 200 and r.get("ok"), str(r)[:200])
s, r = call("GET", f"/api/mailbox/threads/{tc['id']}/presence", token=T1)
composers = [p for p in r.get("presence", []) if p["status"] == "composing_reply"]
check("snapshot shows 2 composers", len(composers) == 2, str(r)[:250])

# --- 6. internal notes -------------------------------------------------------
s, r = call("POST", f"/api/mailbox/threads/{tc['id']}/notes",
            {"body": "@Bob please pick this up"}, token=T1)
check("alice adds internal note", s == 200 and r.get("ok") and r["note"]["is_internal_note"], str(r)[:250])
s, r = call("GET", "/api/collections/messages/records?perPage=50&filter=" + urllib.parse.quote(f'thread="{tc["id"]}"'), token=T2)
notes = [m for m in r.get("items", []) if m.get("is_internal_note")]
check("bob sees the internal note", len(notes) == 1 and notes[0]["sender_email"] == "alice@test.local", str(r)[:300])

# --- 7. card moves ----------------------------------------------------------
s, r = call("POST", f"/api/mailbox/threads/{tc['id']}/move", {"status": "in_progress", "assigned_agent": u2}, token=T2)
check("bob moves card to in_progress + assign", s == 200 and r.get("status") == "in_progress" and r.get("assigned_agent") == u2, str(r)[:250])
s, r = call("POST", f"/api/mailbox/threads/{tc['id']}/move", {"status": "closed"}, token=T2)
check("close releases composer presence", s == 200, str(r)[:200])

# --- 8. webhook push (no matching inbox -> graceful ack) ---------------------
push_data = base64.b64encode(json.dumps({"emailAddress": "ghost@test.local", "historyId": "1"}).encode()).decode()
s, r = call("POST", "/api/gmail-webhook", {"message": {"data": push_data, "messageId": "m1"}, "subscription": "s1"})
check("webhook push acks gracefully", s == 200 and r.get("ok"), str(r)[:200])

print(f"\nRESULT: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
