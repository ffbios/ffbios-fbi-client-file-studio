function supportPriorityLabel(priority) {
  return ({ studio: "Studio priority", high: "High priority", priority: "Priority", standard: "Standard" })[String(priority || "standard")] || "Standard";
}
function supportStatusLabel(status) {
  return ({ open: "Open", in_progress: "In progress", waiting_on_customer: "Waiting on you", resolved: "Resolved" })[String(status || "open")] || "Open";
}
function supportTimestamp(value) {
  try { return value ? new Date(value).toLocaleString() : ""; } catch { return String(value || ""); }
}
async function loadSupportTickets() {
  const list = document.querySelector("#supportTicketList");
  if (list) list.innerHTML = '<div class="empty">Loading your requests…</div>';
  try {
    const data = await api("/api/portal/support/tickets");
    supportTicketCache = Array.isArray(data.tickets) ? data.tickets : [];
    renderSupportTicketList();
    if (activeSupportTicketId && supportTicketCache.some(ticket => ticket.id === activeSupportTicketId)) {
      await openSupportTicket(activeSupportTicketId);
    } else {
      const detail = document.querySelector("#supportTicketDetail");
      if (detail) detail.innerHTML = '<div class="empty">Choose a request from the list or submit a new one.</div>';
      const title = document.querySelector("#supportTicketTitle");
      if (title) title.textContent = "Open a request";
      const replyForm = document.querySelector("#supportReplyForm");
      if (replyForm) replyForm.style.display = "none";
    }
    const createStatus = document.querySelector("#supportCreateStatus");
    const bill = billingData?.current || {};
    if (createStatus) createStatus.textContent = "Your current support level: " + supportPriorityLabel(({"studio":"studio","professional":"high","creator":"priority"})[bill.plan_id] || "standard") + ".";
  } catch (error) {
    if (list) list.innerHTML = '<div class="empty-action">' + esc(error.message || "Could not load support requests.") + '</div>';
  }
}
function renderSupportTicketList() {
  const box = document.querySelector("#supportTicketList");
  if (!box) return;
  if (!supportTicketCache.length) {
    box.innerHTML = '<div class="empty">No support requests yet. Use the form below to contact FBI support.</div>';
    return;
  }
  box.innerHTML = supportTicketCache.map(ticket =>
    '<button type="button" class="shared-card" data-open-support-ticket="' + esc(ticket.id) + '" style="width:100%;text-align:left;border:1px solid var(--border);background:' + (ticket.id === activeSupportTicketId ? 'rgba(212,175,55,.08)' : 'transparent') + ';color:inherit;margin-bottom:7px"><div class="shared-icon">?</div><div class="shared-card-main"><b>' + esc(ticket.subject) + '</b><span>' + esc(supportPriorityLabel(ticket.priority)) + ' • ' + esc(supportStatusLabel(ticket.status)) + '</span><span>' + esc(supportTimestamp(ticket.updated_at || ticket.created_at)) + '</span></div></button>'
  ).join("");
  box.querySelectorAll("[data-open-support-ticket]").forEach(button => {
    button.addEventListener("click", () => openSupportTicket(button.dataset.openSupportTicket));
  });
}
async function openSupportTicket(id) {
  activeSupportTicketId = String(id || "");
  const detail = document.querySelector("#supportTicketDetail");
  if (detail) detail.innerHTML = '<div class="empty">Loading conversation…</div>';
  try {
    const data = await api("/api/portal/support/tickets/" + encodeURIComponent(activeSupportTicketId));
    const ticket = data.ticket || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const title = document.querySelector("#supportTicketTitle");
    if (title) title.textContent = ticket.subject || "Support request";
    if (detail) detail.innerHTML =
      '<div class="billing-overview-card"><div class="billing-overview-top"><div><div class="billing-kicker">' + esc(supportPriorityLabel(ticket.priority)) + '</div><h3>' + esc(ticket.subject || "Support request") + '</h3></div><span class="billing-pill">' + esc(supportStatusLabel(ticket.status)) + '</span></div><p>' + esc(ticket.category || "other") + ' • Created ' + esc(supportTimestamp(ticket.created_at)) + '</p></div>' +
      '<div style="display:grid;gap:9px;margin-top:12px">' + messages.map(message =>
        '<article class="panel" style="margin:0"><div class="panelhead"><b>' + esc(message.sender_name || (message.sender_type === "admin" ? "FBI Support" : "You")) + '</b><span>' + esc(supportTimestamp(message.created_at)) + '</span></div><div class="panelbody" style="white-space:pre-wrap;line-height:1.6">' + esc(message.message) + '</div></article>'
      ).join("") + '</div>';
    const replyForm = document.querySelector("#supportReplyForm");
    if (replyForm) {
      replyForm.style.display = ticket.status === "resolved" ? "none" : "block";
      replyForm.dataset.ticketId = ticket.id;
      const replyMessage = document.querySelector("#supportReplyMessage");
      if (replyMessage) replyMessage.value = "";
    }
    renderSupportTicketList();
  } catch (error) {
    if (detail) detail.innerHTML = '<div class="empty-action">' + esc(error.message || "Could not open this support request.") + '</div>';
  }
}
const supportNewTicketForm = document.querySelector("#supportNewTicketForm");
if (supportNewTicketForm) supportNewTicketForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = supportNewTicketForm.querySelector('button[type="submit"]');
  const status = document.querySelector("#supportCreateStatus");
  button.disabled = true;
  if (status) status.textContent = "Submitting support request…";
  try {
    const result = await api("/api/portal/support/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: document.querySelector("#supportCategory").value,
        subject: document.querySelector("#supportSubject").value.trim(),
        message: document.querySelector("#supportMessage").value.trim()
      })
    });
    supportNewTicketForm.reset();
    activeSupportTicketId = result.ticket?.id || null;
    toastPortal("Support request submitted.");
    await loadSupportTickets();
  } catch (error) {
    if (status) status.textContent = error.message || "Could not submit the request.";
  } finally {
    button.disabled = false;
  }
});
const supportReplyForm = document.querySelector("#supportReplyForm");
if (supportReplyForm) supportReplyForm.addEventListener("submit", async event => {
  event.preventDefault();
  const ticketId = supportReplyForm.dataset.ticketId;
  const message = document.querySelector("#supportReplyMessage").value.trim();
  const button = supportReplyForm.querySelector('button[type="submit"]');
  if (!ticketId || !message) return;
  button.disabled = true;
  try {
    await api("/api/portal/support/tickets/" + encodeURIComponent(ticketId) + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    toastPortal("Reply sent.");
    await loadSupportTickets();
  } catch (error) {
    toastPortal(error.message || "Could not send your reply.");
  } finally {
    button.disabled = false;
  }
});
