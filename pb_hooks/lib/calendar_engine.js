// =============================================================================
// gw-mailbox — calendar/meet handlers (module)
// "1-Click Meeting" engine (Calendar API v3). See note in presence_api.js on
// why handlers live in a module.
// =============================================================================

var h = require(__hooks + "/lib/helpers.js");

function calendarOwnerEmail(threadRec) {
  const inbox = h.safeFindById("inboxes", threadRec.getString("inbox"));
  return inbox ? inbox.getString("email_address") : "";
}

function tz() {
  return $os.getenv("MAILBOX_TIMEZONE") || "UTC";
}

function readBody(e) {
  try { return JSON.parse(toString(e.request.body) || "{}"); } catch (_) { return {}; }
}

// Round free time down to :00/:30 buckets; emit slots of the requested length
// that do not intersect any busy interval.
function freeSlots(startDt, endDt, busy, durationMin) {
  const STEP = 30 * 60 * 1000;
  const DUR = durationMin * 60 * 1000;
  const slots = [];
  let cursor = new Date(Math.ceil(startDt.getTime() / STEP) * STEP);
  const end = endDt.getTime();

  while (cursor.getTime() + DUR <= end) {
    const slotEnd = cursor.getTime() + DUR;
    const clash = busy.some((b) => {
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      return cursor.getTime() < be && slotEnd > bs; // overlap
    });
    if (!clash) slots.push({ start: cursor.toISOString(), end: new Date(slotEnd).toISOString() });
    cursor = new Date(cursor.getTime() + STEP);
  }
  return slots;
}

// GET availability
function handleAvailability(e) {
  if (h.addCorsHeaders(e, "GET, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;
  const thread = access.thread;

  const q = e.request.url.query();
  const timeMin = q.get("start") || "";
  const timeMax = q.get("end") || "";
  const durationMin = Math.max(15, parseInt(q.get("durationMin") || "30", 10) || 30);
  if (!timeMin || !timeMax || new Date(timeMin) - new Date(timeMax) >= 0) {
    return h.fail(e, 400, "invalid_range", "start/end RFC3339 required and start < end");
  }

  const calendarId = calendarOwnerEmail(thread);
  try {
    const fb = h.googleRequest({
      url: h.CAL_BASE + "/freeBusy",
      method: "POST",
      body: {
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        timeZone: tz(),
        items: [{ id: calendarId }]
      },
      scopes: [h.CAL_SCOPE, h.CAL_READ_SCOPE],
      subject: calendarId
    });

    const busy = ((fb.calendars && fb.calendars[calendarId] && fb.calendars[calendarId].busy) || [])
      .map((b) => ({ start: b.start, end: b.end }));
    const slots = freeSlots(new Date(timeMin), new Date(timeMax), busy, durationMin);

    e.json(200, { ok: true, calendar: calendarId, busy: busy, suggestedSlots: slots });
  } catch (err) {
    e.json(200, { ok: false, error: "calendar_error", message: (err && err.message) || String(err) });
  }
}

// POST meet — insert Google Meet event, link card, internal note, waiting_customer
function handleBookMeet(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;
  const thread = access.thread;

  const body = readBody(e);
  const startIso = body.start || "";
  const endIso = body.end || "";
  if (!startIso || !endIso || new Date(endIso) - new Date(startIso) <= 0) {
    return h.fail(e, 400, "invalid_range", "start/end RFC3339 required and start < end");
  }

  const calendarId = calendarOwnerEmail(thread);
  if (!calendarId) return h.fail(e, 400, "inbox_missing", "Thread inbox has no email_address");

  const summary = String(body.summary || thread.getString("subject") || "Support meeting").slice(0, 200);
  const customerEmail = thread.getString("customer_email");
  const customerName = thread.getString("customer_name") || customerEmail;

  const eventPayload = {
    summary: summary,
    description: String(body.description || "Meeting booked from " + summary + " (#" + threadId + ")").slice(0, 4000),
    start: { dateTime: new Date(startIso).toISOString(), timeZone: tz() },
    end: { dateTime: new Date(endIso).toISOString(), timeZone: tz() },
    guestsCanModify: true,
    guestsCanSeeOtherGuests: false,
    conferenceData: {
      createRequest: {
        requestId: $security.randomString(32),
        conferenceSolutionKey: { type: "hangoutsMeet" }
      }
    },
    attendees: [{ email: customerEmail, displayName: customerName, responseStatus: "accepted" }]
  };

  // The agent creating the booking is added as an attendee (they get the Meet
  // invite + link). If they act AS the mailbox this is a no-op self-add; when
  // they're a real user we keep them so they can be promoted to co-host by the
  // host or modify the event (guestsCanModify). The explicit hostEmail (when
  // supplied by the UI) is ALSO added as an attendee so Meet knows who booked.
  const agentEmail = (body.hostEmail || actor.email || "").toString().trim();
  const allEmails = [customerEmail, agentEmail]
    .concat((body.attendees || []).map((a) => a && a.email))
    .filter((e) => e)
    .map((e) => String(e).toLowerCase());
  const seen = {};
  const addEmail = (email, displayName) => {
    const e = String(email || "").trim().toLowerCase();
    if (!e || seen[e]) return;
    seen[e] = true;
    eventPayload.attendees.push({ email: e, displayName: displayName || "" });
  };
  // customer already first
  seen[String(customerEmail).toLowerCase()] = true;
  addEmail(agentEmail, actor.name);
  for (const extra of body.attendees || []) {
    if (extra && extra.email) addEmail(extra.email, extra.name);
  }

  try {
    const created = h.googleRequest({
      url: h.CAL_BASE + "/calendars/" + encodeURIComponent(calendarId) + "/events?conferenceDataVersion=1&sendUpdates=none",
      method: "POST",
      body: eventPayload,
      scopes: [h.CAL_SCOPE],
      subject: calendarId
    });

    const hangoutLink = (created.hangoutLink || created.htmlLink || "").toString();

    thread.set("calendar_event_id", created.id || "");
    thread.set("status", "waiting_customer");
    try {
      require(__hooks + "/lib/automations_engine.js").resetFollowups(thread);
    } catch (_) { /* non-fatal */ }
    $app.save(thread);

    h.addInternalNote(threadId, actor, [
      "📅 Meeting booked with " + customerName + " (" + customerEmail + ")",
      "When: " + new Date(startIso).toISOString() + " → " + new Date(endIso).toISOString(),
      "Summary: " + summary,
      hangoutLink ? "Meet: " + hangoutLink : ""
    ].filter(Boolean).join("\n"), { eventId: created.id, hangoutLink: hangoutLink });

    e.json(200, {
      ok: true,
      calendar_event_id: created.id || "",
      hangoutLink: hangoutLink,
      htmlLink: created.htmlLink || "",
      status: thread.getString("status")
    });
  } catch (err) {
    e.json(200, { ok: false, error: "meet_create_failed", message: (err && err.message) || String(err) });
  }
}

// POST cancel-meet
function handleCancelMeet(e) {
  if (h.addCorsHeaders(e, "POST, OPTIONS")) return;
  const actor = h.actorFromEvent(e);
  if (!actor) return h.fail(e, 401, "unauthorized", "Auth required");

  const threadId = e.request.pathValue("id");
  const access = h.requireThreadAccess(e, threadId, actor);
  if (!access) return;
  const thread = access.thread;

  const eventId = thread.getString("calendar_event_id");
  const calendarId = calendarOwnerEmail(thread);
  if (!eventId) return h.fail(e, 400, "no_event", "Thread has no linked calendar event");

  try {
    h.googleRequest({
      url: h.CAL_BASE + "/calendars/" + encodeURIComponent(calendarId) + "/events/" + encodeURIComponent(eventId),
      method: "DELETE",
      scopes: [h.CAL_SCOPE],
      subject: calendarId
    });
    thread.set("calendar_event_id", "");
    $app.save(thread);
    h.addInternalNote(threadId, actor, "Meeting cancelled (event " + eventId + ").", { eventId: eventId });
    e.json(200, { ok: true });
  } catch (err) {
    e.json(200, { ok: false, error: "meet_cancel_failed", message: (err && err.message) || String(err) });
  }
}

module.exports = {
  handleAvailability,
  handleBookMeet,
  handleCancelMeet
};
