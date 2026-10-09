let teamWorkspaceState = null;

async function loadTeamWorkspace() {
  const box = document.querySelector("#teamWorkspaceContent");
  if (box) box.innerHTML = '<div class="empty">Loading team workspace…</div>';
  try {
    teamWorkspaceState = await api("/api/portal/team");
    renderTeamWorkspace();
  } catch (error) {
    if (box) box.innerHTML = '<div class="empty-action">' + esc(error.message || "Could not load the team workspace.") + '</div>';
  }
}

function copyTeamInvitation(url) {
  const value = String(url || "");
  if (!value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(
      () => toastPortal("Invitation link copied."),
      () => window.prompt("Copy this invitation link:", value)
    );
  } else {
    window.prompt("Copy this invitation link:", value);
  }
}

function renderTeamWorkspace() {
  const box = document.querySelector("#teamWorkspaceContent");
  if (!box) return;
  const data = teamWorkspaceState || {};
  if (!data.available) {
    box.innerHTML = '<div class="panel"><div class="panelhead"><h3>Studio Team Workspace</h3></div><div class="panelbody"><p>Team Workspace is included with the active Studio subscription. The owner and two teammates use their own email accounts and share one storage allowance.</p><button type="button" class="btn primary" data-team-billing>View Storage Plans</button></div></div>';
    box.querySelector("[data-team-billing]")?.addEventListener("click", () => selectPortalNav("billing"));
    return;
  }

  const workspace = data.workspace || {};
  const members = Array.isArray(data.members) ? data.members : [];
  const invitations = Array.isArray(data.invitations) ? data.invitations : [];
  const isOwner = data.is_owner === true;
  const isActive = data.active === true;
  const expiration = workspace.current_period_end ? new Date(workspace.current_period_end).toLocaleDateString() : "—";
  const memberRows = members.map(member => {
    const isWorkspaceOwner = member.role === "owner";
    const role = isOwner && !isWorkspaceOwner
      ? '<select class="inputlike" data-member-role="' + esc(member.user_id) + '"><option value="editor" ' + (member.role === "editor" ? "selected" : "") + '>Editor</option><option value="viewer" ' + (member.role === "viewer" ? "selected" : "") + '>Viewer</option></select>'
      : '<span class="billing-pill">' + esc(isWorkspaceOwner ? "Owner" : member.role) + '</span>';
    const remove = isOwner && !isWorkspaceOwner ? '<button type="button" class="btn danger" data-remove-member="' + esc(member.user_id) + '">Remove</button>' : "";
    return '<div class="billing-history-row" style="grid-template-columns:minmax(0,1fr) auto auto;gap:8px"><div><b>' + esc(member.full_name || member.email) + '</b><span>' + esc(member.email) + '</span></div><div>' + role + '</div><div>' + remove + '</div></div>';
  }).join("");

  const invitationRows = invitations.map(invite => {
    return '<div class="billing-history-row" style="grid-template-columns:minmax(0,1fr) auto;gap:8px"><div><b>' + esc(invite.email) + '</b><span>Pending invitation • expires ' + esc(new Date(invite.expires_at).toLocaleDateString()) + '</span></div><div><span class="billing-pill">' + esc(invite.role) + '</span> <button type="button" class="btn danger" data-cancel-invite="' + esc(invite.id) + '">Cancel</button></div></div>';
  }).join("");

  const totalSeats = Number(data.seat_limit || 3);
  const usedSeats = Number(data.seat_count || members.length);
  box.innerHTML =
    '<div class="dashboard-wide"><div class="dashboard-card"><div class="billing-kicker">Studio Workspace</div><h2 style="margin:7px 0">' + esc(workspace.name || "Your Studio") + '</h2><p>Owned by ' + esc(workspace.owner_name || workspace.owner_email || "you") + '</p><div class="billing-big-price">' + usedSeats + ' / ' + totalSeats + ' <small>accounts reserved</small></div><p>One shared storage allowance for the owner and team. Subscription period ends ' + esc(expiration) + '.</p><span class="billing-pill ' + (isActive ? "" : "expired") + '">' + (isActive ? "Active Studio plan" : "Studio plan inactive") + '</span></div><div class="dashboard-card"><div class="billing-kicker">Team access</div><h3>Individual sign-ins, shared projects</h3><p>Each teammate signs in with their own email. Editors can upload and manage team projects; viewers have read-only access. Only the owner controls billing.</p><p><b>Plan limit:</b> three named accounts in total, including the owner.</p></div></div>' +
    (!isActive ? '<div class="billing-notice"><strong>Team access is paused.</strong>Renew the Studio subscription to restore shared project and upload access.</div>' : '') +
    '<div class="panel" style="margin-top:14px"><div class="panelhead"><h3>Team Members</h3><p>Adjust access roles or remove a teammate.</p></div><div class="panelbody">' + (memberRows || '<div class="empty">No members yet.</div>') + '</div></div>' +
    (isOwner
      ? '<div class="panel" style="margin-top:14px"><div class="panelhead"><h3>Invite a Teammate</h3><p>Three accounts total: you plus up to two teammates.</p></div><div class="panelbody"><form id="teamInviteForm"><div class="settinggrid"><div class="field"><label for="teamInviteEmail">Teammate email</label><input id="teamInviteEmail" type="email" required placeholder="editor@example.com"></div><div class="field"><label for="teamInviteRole">Access role</label><select id="teamInviteRole" class="inputlike"><option value="editor">Editor • Upload and manage team projects</option><option value="viewer">Viewer • Read-only project access</option></select></div></div><div id="teamInviteStatus" class="billing-muted" style="margin-bottom:9px"></div><button type="submit" class="btn primary" ' + (!isActive || usedSeats >= totalSeats ? "disabled" : "") + '>Create Invitation</button></form></div></div><div class="panel" style="margin-top:14px"><div class="panelhead"><h3>Pending Invitations</h3></div><div class="panelbody">' + (invitationRows || '<div class="empty">No pending invitations.</div>') + '</div></div>'
      : '<div class="billing-notice"><strong>Workspace membership</strong>Only the workspace owner can invite or remove teammates and manage the subscription.</div>');

  box.querySelectorAll("[data-member-role]").forEach(select => {
    select.addEventListener("change", async () => {
      try {
        await api("/api/portal/team/members/" + encodeURIComponent(select.dataset.memberRole), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: select.value }) });
        toastPortal("Team role updated.");
        await loadTeamWorkspace();
      } catch (error) {
        toastPortal(error.message);
        await loadTeamWorkspace();
      }
    });
  });
  box.querySelectorAll("[data-remove-member]").forEach(button => {
    button.addEventListener("click", async () => {
      if (!confirm("Remove this member's Studio workspace access? Their individual account will remain intact.")) return;
      try {
        await api("/api/portal/team/members/" + encodeURIComponent(button.dataset.removeMember), { method: "DELETE" });
        toastPortal("Workspace access removed.");
        await loadTeamWorkspace();
        await loadProjects();
      } catch (error) { toastPortal(error.message); }
    });
  });
  box.querySelectorAll("[data-cancel-invite]").forEach(button => {
    button.addEventListener("click", async () => {
      try {
        await api("/api/portal/team/invitations/" + encodeURIComponent(button.dataset.cancelInvite), { method: "DELETE" });
        toastPortal("Invitation cancelled.");
        await loadTeamWorkspace();
      } catch (error) { toastPortal(error.message); }
    });
  });
  box.querySelectorAll("[data-copy-invite]").forEach(button => {
    button.addEventListener("click", () => copyTeamInvitation(button.dataset.inviteUrl));
  });
  const form = document.querySelector("#teamInviteForm");
  if (form) form.addEventListener("submit", async event => {
    event.preventDefault();
    const status = document.querySelector("#teamInviteStatus");
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "Creating invitation…";
    try {
      const result = await api("/api/portal/team/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: document.querySelector("#teamInviteEmail").value.trim(), role: document.querySelector("#teamInviteRole").value }) });
      if (result.invitation_url) {
        copyTeamInvitation(result.invitation_url);
        toastPortal("Invitation link copied. Send it to " + result.email + ".");
      } else {
        toastPortal("The existing account has been added to the workspace.");
      }
      await loadTeamWorkspace();
    } catch (error) {
      status.textContent = error.message || "Could not create the invitation.";
    } finally {
      button.disabled = false;
    }
  });
}

async function acceptWorkspaceInvitationIfPresent() {
  const params = new URLSearchParams(location.search);
  const token = params.get("invite");
  if (!token || !me) return;
  try {
    const result = await api("/api/portal/team/invitations/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    params.delete("invite");
    const search = params.toString();
    window.history.replaceState({}, "", location.pathname + (search ? "?" + search : "") + location.hash);
    toastPortal("You joined " + (result.workspace_name || "the Studio workspace") + ".");
    await loadProjects();
    await selectPortalNav("team");
  } catch (error) {
    toastPortal(error.message || "Could not accept this invitation.");
  }
}

const originalEnterPortalWithTeam = enterPortal;
enterPortal = async function(user) {
  await originalEnterPortalWithTeam(user);
  await acceptWorkspaceInvitationIfPresent();
};

if (me) acceptWorkspaceInvitationIfPresent();
