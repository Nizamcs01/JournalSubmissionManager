/* Journal Submission Manager — HTML/CSS/JS + Firebase Authentication/Cloud Firestore */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  confirmPasswordReset,
  verifyPasswordResetCode,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  query,
  orderBy,
  setDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

(() => {
  "use strict";

  const CONFIG = window.JSM_CONFIG || {};
  const firebaseConfig = CONFIG.FIREBASE_CONFIG || {};
  const requiredFirebaseKeys = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"];
  const hasConfig = requiredFirebaseKeys.every(key => Boolean(firebaseConfig[key]));

  let firebaseApp = null;
  let auth = null;
  let db = null;
  if (hasConfig) {
    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);
    setPersistence(auth, browserLocalPersistence).catch(() => {});
  }

  const STATUSES = [
    "Submitted", "Editor Assigned", "Under Review", "Minor Revision", "Major Revision",
    "Revised Manuscript Submitted", "Accepted", "Published", "Rejected", "Desk Rejected", "Withdrawn"
  ];
  const QUARTILES = ["Q1", "Q2", "Q3", "Q4", "Unranked"];
  const INDEXING = ["Scopus", "Web of Science", "Scopus + Web of Science", "UGC Care", "Other", "Not Indexed"];

  const state = {
    view: "dashboard",
    clients: [],
    journals: [],
    submissions: [],
    history: [],
    filters: { search: "", client: "", status: "", from: "", to: "" }
  };
  let session = null;
  let authBusy = false;
  let resetCode = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[ch]));
  const isoNow = () => new Date().toISOString();
  const today = () => new Date().toISOString().slice(0, 10);
  const makeId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  const fmtDate = value => value ? new Date(String(value).length === 10 ? `${value}T00:00:00` : value)
    .toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";
  const slugStatus = value => String(value || "Not Set").replace(/\s+/g, "-");
  const cleanFile = value => String(value || "export").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "export";

  function toast(message, type = "") {
    const el = $("#toast");
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.className = "toast"; }, 3000);
  }

  function showAuth(message = "", type = "") {
    $("#authView").classList.remove("hidden");
    $("#resetView").classList.add("hidden");
    $("#appView").classList.add("hidden");
    const notice = $("#authNotice");
    if (message) {
      notice.textContent = message;
      notice.className = `notice ${type}`;
    } else {
      notice.textContent = "";
      notice.className = "notice hidden";
    }
  }

  function showReset(message = "", type = "") {
    $("#authView").classList.add("hidden");
    $("#resetView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
    const notice = $("#resetNotice");
    if (notice) {
      notice.textContent = message;
      notice.className = message ? `notice ${type}` : "notice hidden";
    }
  }

  function showApp() {
    $("#authView").classList.add("hidden");
    $("#resetView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    $("#userEmail").textContent = session?.user?.email || "Signed-in user";
  }

  function renderConfigState() {
    const notice = $("#authNotice");
    const help = $("#configHelp");
    const loginButton = $("#loginForm button[type=submit]");
    const forgot = $("#forgotPasswordBtn");
    if (!hasConfig) {
      notice.className = "notice error";
      notice.textContent = "Firebase is not configured yet. Add your Firebase web app configuration to config.js before signing in.";
      help.className = "auth-config";
      help.innerHTML = "Setup: create a Firebase project → register a Web app → enable Authentication > Email/Password → create a Cloud Firestore database → create your first user in Authentication → Users → paste the Firebase web app configuration into <b>config.js</b>.";
      loginButton.disabled = true;
      forgot.disabled = true;
      loginButton.title = "Configure Firebase first";
    } else {
      notice.className = "notice hidden";
      help.className = "auth-config hidden";
      loginButton.disabled = false;
      forgot.disabled = false;
      loginButton.removeAttribute("title");
    }
  }

  function clientById(id) { return state.clients.find(c => c.id === id); }
  function journalById(id) { return state.journals.find(j => j.id === id); }

  const collectionMap = { clients: "clients", journals: "journals", submissions: "submissions", history: "status_history" };

  function userCollection(key) {
    if (!db || !session?.user?.uid) throw new Error("You must be signed in.");
    const collectionName = collectionMap[key];
    if (!collectionName) throw new Error(`Unknown collection: ${key}`);
    return collection(db, "users", session.user.uid, collectionName);
  }

  async function loadCloud() {
    if (!db || !session) throw new Error("You must be signed in.");
    const [clients, journals, submissions, history] = await Promise.all([
      selectAll("clients", "created_at"),
      selectAll("journals", "created_at"),
      selectAll("submissions", "submission_date"),
      selectAll("history", "created_at")
    ]);
    state.clients = clients;
    state.journals = journals;
    state.submissions = submissions;
    state.history = history;
  }

  async function selectAll(key, orderByField) {
    const snapshot = await getDocs(query(userCollection(key), orderBy(orderByField, "desc")));
    return snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
  }

  async function insertRecord(key, row) {
    const payload = { ...row, user_id: session.user.uid };
    const ref = doc(userCollection(key), payload.id || makeId(key));
    payload.id = ref.id;
    await setDoc(ref, payload);
    const data = { ...payload };
    state[key].push(data);
    return data;
  }

  async function updateRecord(key, id, patch) {
    const ref = doc(userCollection(key), id);
    const payload = { ...patch };
    delete payload.user_id;
    if (key === "submissions") payload.updated_at = isoNow();
    await updateDoc(ref, payload);
    const idx = state[key].findIndex(r => r.id === id);
    if (idx >= 0) state[key][idx] = { ...state[key][idx], ...payload };
    return state[key][idx];
  }

  async function deleteRecord(key, id) {
    await deleteDoc(doc(userCollection(key), id));
    state[key] = state[key].filter(r => r.id !== id);
  }

  async function addHistory(submissionId, status, note = "") {
    if (!status) return;
    return insertRecord("history", {
      id: makeId("hist"),
      submission_id: submissionId,
      status,
      note: note || null,
      created_at: isoNow()
    });
  }

  function statusCounts() {
    return state.submissions.reduce((map, row) => {
      const key = row.current_status || "Not Set";
      map[key] = (map[key] || 0) + 1;
      return map;
    }, {});
  }

  function matchesFilters(row, f = state.filters) {
    const client = clientById(row.client_id);
    const journal = journalById(row.journal_id);
    const searchBlob = [
      client?.name, client?.phone, client?.email, client?.organization,
      row.paper_title, journal?.name, journal?.publisher,
      row.submission_id, row.corresponding_author, row.email, row.remarks
    ].join(" ").toLowerCase();
    if (f.search && !searchBlob.includes(f.search.toLowerCase())) return false;
    if (f.client && row.client_id !== f.client) return false;
    if (f.status === "__NOT_SET__" && row.current_status) return false;
    if (f.status && f.status !== "__NOT_SET__" && row.current_status !== f.status) return false;
    if (f.from && row.submission_date < f.from) return false;
    if (f.to && row.submission_date > f.to) return false;
    return true;
  }

  function filteredSubmissions() {
    return [...state.submissions]
      .filter(row => matchesFilters(row))
      .sort((a, b) => String(b.submission_date || "").localeCompare(String(a.submission_date || "")) || String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  }

  function render() {
    $("#userEmail").textContent = session?.user?.email || "Signed-in user";
    $$(".tab").forEach(button => button.classList.toggle("active", button.dataset.view === state.view));
    const container = $("#viewContainer");
    container.innerHTML = {
      dashboard: dashboardView,
      submissions: submissionsView,
      clients: clientsView,
      journals: journalsView,
      reports: reportsView
    }[state.view]();
    bindViewEvents();
  }

  function kpi(label, value) {
    return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${Number(value || 0)}</div></div>`;
  }

  function dashboardView() {
    const counts = statusCounts();
    const revision = (counts["Minor Revision"] || 0) + (counts["Major Revision"] || 0) + (counts["Revised Manuscript Submitted"] || 0);
    const total = state.submissions.length;
    const monthly = monthlyCounts(12);
    return `<div class="page">
      <div class="section-title">Submission Overview</div>
      <div class="kpi-grid">
        ${kpi("Total Papers", total)}
        ${kpi("Submitted", counts.Submitted)}
        ${kpi("Under Review", counts["Under Review"])}
        ${kpi("Revision", revision)}
        ${kpi("Accepted", counts.Accepted)}
        ${kpi("Published", counts.Published)}
        ${kpi("Rejected", counts.Rejected)}
      </div>
      <div class="dashboard-grid">
        <section class="panel">
          <div class="panel-head"><div><h3>Status Breakdown</h3><div class="sub">Current status of all submissions</div></div></div>
          <div class="panel-body">${statusBreakdownTable(counts)}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><div><h3>Recent Monthly Submissions</h3><div class="sub">Last 12 calendar months</div></div></div>
          <div class="panel-body">${monthlyTable(monthly)}</div>
        </section>
      </div>
    </div>`;
  }

  function statusBreakdownTable(counts) {
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return `<div class="empty">No submission data.</div>`;
    return `<table class="data-table"><thead><tr><th>Status</th><th class="num">Papers</th></tr></thead><tbody>${rows.map(([status, count]) =>
      `<tr><td><span class="status ${slugStatus(status)}">${esc(status)}</span></td><td class="num">${count}</td></tr>`
    ).join("")}</tbody></table>`;
  }

  function monthlyCounts(months = 12) {
    const map = {};
    const base = new Date();
    for (let i = 0; i < months; i += 1) {
      const d = new Date(base.getFullYear(), base.getMonth() - (months - 1 - i), 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      map[key] = 0;
    }
    state.submissions.forEach(row => {
      if (row.submission_date) {
        const key = String(row.submission_date).slice(0, 7);
        if (Object.prototype.hasOwnProperty.call(map, key)) map[key] += 1;
      }
    });
    return Object.entries(map).map(([key, count]) => {
      const [y, m] = key.split("-").map(Number);
      return { label: new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" }), count };
    }).reverse();
  }

  function monthlyTable(rows) {
    return `<table class="data-table"><thead><tr><th>Month</th><th class="num">Submissions</th></tr></thead><tbody>${rows.map(r =>
      `<tr><td>${esc(r.label)}</td><td class="num">${r.count}</td></tr>`
    ).join("")}</tbody></table>`;
  }

  function submissionTable(rows) {
    if (!rows.length) return `<div class="empty">No submissions found.</div>`;
    return `<div class="table-scroll"><table class="data-table submission-table"><thead><tr>
      <th>#</th><th>Client</th><th>Paper Title</th><th>Journal</th><th>Submission Date</th><th>Submission ID</th><th>Quartile</th><th>Indexing</th><th>APC</th><th>Status</th><th>Username</th><th>Password</th><th>Author</th><th>Actions</th>
    </tr></thead><tbody>${rows.map((row, idx) => {
      const c = clientById(row.client_id);
      const j = journalById(row.journal_id);
      return `<tr>
        <td class="num">${idx + 1}</td>
        <td>${esc(c?.name || "—")}<div class="table-sub">${esc(c?.phone || c?.email || "")}</div></td>
        <td><div class="table-title">${esc(row.paper_title)}</div></td>
        <td>${esc(j?.name || "—")}<div class="table-sub">${esc(j?.publisher || "")}</div></td>
        <td>${fmtDate(row.submission_date)}</td>
        <td>${esc(row.submission_id || "") || "—"}</td>
        <td>${esc(row.journal_quartile || "") || "—"}</td>
        <td>${esc(row.indexing || "") || "—"}</td>
        <td>${formatApc(row.apc)}</td>
        <td><span class="status ${slugStatus(row.current_status)}">${esc(row.current_status || "Not Set")}</span></td>
        <td>${esc(row.journal_username || "") || "—"}</td>
        <td>${row.journal_password ? "••••••••" : "—"}</td>
        <td>${esc(row.corresponding_author || "") || "—"}</td>
        <td><div class="list-actions"><button class="btn small" data-action="view-sub" data-id="${esc(row.id)}">View</button><button class="btn small" data-action="edit-sub" data-id="${esc(row.id)}">Edit</button><button class="btn small danger" data-action="delete-sub" data-id="${esc(row.id)}">Delete</button></div></td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
  }

  function formatApc(value) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : esc(value);
  }

  function submissionsView() {
    const f = state.filters;
    return `<div class="page">
      <div class="section-title">Submission Records</div>
      <div class="panel-head" style="background:#fff;border:1px solid var(--line);margin-bottom:10px">
        <div><h3 style="margin:0;color:var(--header);font-size:14px">Manage Submissions</h3><div class="sub">Search, filter, update status, view history and export.</div></div>
        <button class="btn accent" data-action="new-sub">+ New Submission</button>
      </div>
      <div class="toolbar">
        <div class="field search"><label>Search<input id="fSearch" value="${esc(f.search)}" placeholder="Client, title, journal, ID..."></label></div>
        <div class="field"><label>Client<select id="fClient"><option value="">All Clients</option>${state.clients.map(c => `<option value="${esc(c.id)}" ${f.client === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label></div>
        <div class="field"><label>Status<select id="fStatus"><option value="">All Statuses</option><option value="__NOT_SET__" ${f.status === "__NOT_SET__" ? "selected" : ""}>Not Set</option>${STATUSES.map(s => `<option ${f.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label></div>
        <div class="field"><label>From<input id="fFrom" type="date" value="${esc(f.from)}"></label></div>
        <div class="field"><label>To<input id="fTo" type="date" value="${esc(f.to)}"></label></div>
        <button class="btn" data-action="filter-sub">Filter</button>
        <button class="btn" data-action="clear-filters">Clear</button>
        <button class="btn" data-action="export-filter">Export Excel</button>
      </div>
      <div id="submissionTable">${submissionTable(filteredSubmissions())}</div>
    </div>`;
  }

  function clientsView() {
    return `<div class="page">
      <div class="section-title">Clients</div>
      <div class="panel-head" style="background:#fff;border:1px solid var(--line);margin-bottom:10px"><div><h3 style="margin:0;color:var(--header);font-size:14px">Client Records</h3><div class="sub">Store contact information and client notes.</div></div><button class="btn accent" data-action="new-client">+ Add Client</button></div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>#</th><th>Client Name</th><th>Email</th><th>Phone</th><th>Organization</th><th>Notes</th><th>Actions</th></tr></thead><tbody>
      ${state.clients.length ? state.clients.map((c, idx) => `<tr><td class="num">${idx + 1}</td><td><b>${esc(c.name)}</b></td><td>${esc(c.email || "") || "—"}</td><td>${esc(c.phone || "") || "—"}</td><td>${esc(c.organization || "") || "—"}</td><td>${esc(c.notes || "") || "—"}</td><td><div class="list-actions"><button class="btn small" data-action="edit-client" data-id="${esc(c.id)}">Edit</button></div></td></tr>`).join("") : `<tr><td colspan="7"><div class="empty">No clients added yet.</div></td></tr>`}
      </tbody></table></div>
    </div>`;
  }

  function journalsView() {
    return `<div class="page">
      <div class="section-title">Journals</div>
      <div class="panel-head" style="background:#fff;border:1px solid var(--line);margin-bottom:10px"><div><h3 style="margin:0;color:var(--header);font-size:14px">Journal Records</h3><div class="sub">Maintain journal metadata for faster submission entry.</div></div><button class="btn accent" data-action="new-journal">+ Add Journal</button></div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>#</th><th>Journal Name</th><th>Publisher</th><th>ISSN / E-ISSN</th><th>Indexing</th><th>Quartile</th><th>APC</th><th>Website</th><th>Actions</th></tr></thead><tbody>
      ${state.journals.length ? state.journals.map((j, idx) => `<tr><td class="num">${idx + 1}</td><td><b>${esc(j.name)}</b></td><td>${esc(j.publisher || "") || "—"}</td><td>${esc(joinIssn(j)) || "—"}</td><td>${esc(j.indexing || "") || "—"}</td><td>${esc(j.quartile || "") || "—"}</td><td>${formatApc(j.apc)}</td><td>${j.website ? `<a href="${esc(j.website)}" target="_blank" rel="noopener noreferrer">Open</a>` : "—"}</td><td><div class="list-actions"><button class="btn small" data-action="edit-journal" data-id="${esc(j.id)}">Edit</button></div></td></tr>`).join("") : `<tr><td colspan="9"><div class="empty">No journals added yet.</div></td></tr>`}
      </tbody></table></div>
    </div>`;
  }

  function reportsView() {
    const counts = statusCounts();
    return `<div class="page">
      <div class="section-title">Excel Reports &amp; Export</div>
      <div class="panel" style="margin-bottom:12px"><div class="panel-body"><b style="color:var(--header)">Export exactly the data you need.</b><div class="form-note" style="margin-top:5px">Client-wise, date-wise and status-wise exports open a selection dialog before generating the Excel file.</div></div></div>
      <div class="cards">
        <div class="report-card"><div class="report-icon">▣</div><h3>All Records</h3><p>Export every submission in your account with client and journal details.</p><button class="btn accent" data-action="export-all">Export to Excel</button></div>
        <div class="report-card"><div class="report-icon">♙</div><h3>Client-wise</h3><p>Select a client first, then export all papers submitted for that client.</p><button class="btn accent" data-action="export-client">Export to Excel</button></div>
        <div class="report-card"><div class="report-icon">▣</div><h3>Date-wise</h3><p>Choose a From and To submission date, then export only that date range.</p><button class="btn accent" data-action="export-date">Export to Excel</button></div>
        <div class="report-card"><div class="report-icon">◆</div><h3>Status-wise</h3><p>Select one status, including Not Set, then export matching submissions.</p><button class="btn accent" data-action="export-status">Export to Excel</button></div>
        <div class="report-card"><div class="report-icon">↗</div><h3>Current Filter</h3><p>Export exactly the currently filtered records from the Submissions screen.</p><button class="btn accent" data-action="export-filter">Export to Excel</button></div>
        <div class="report-card"><div class="report-icon">▤</div><h3>Encrypted Backup</h3><p>Download a password-encrypted backup of the current signed-in user's data. The backup is not readable without the password.</p><button class="btn" data-action="backup-json">Create Encrypted Backup</button></div>
      </div>
      <div class="panel" style="margin-top:12px"><div class="panel-head"><div><h3>Quick Counts</h3><div class="sub">Current submission status distribution</div></div></div><div class="panel-body"><div class="summary-list">${Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([status,n]) => `<div class="summary-row"><span>${esc(status)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, Math.min(100, n * 8))}%"></div></div><b>${n}</b></div>`).join("") || `<div class="empty">No submission data.</div>`}</div></div></div>
    </div>`;
  }

  function joinIssn(journal) {
    return [journal.issn, journal.eissn].filter(Boolean).join(" / ");
  }

  function openModal(title, body, foot = "") {
    $("#modalRoot").innerHTML = `<div class="modal-backdrop" data-close-modal><div class="modal"><div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" data-close type="button">Close</button></div><div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}</div></div>`;
    $("#modalRoot [data-close]").addEventListener("click", closeModal);
    $("#modalRoot .modal-backdrop").addEventListener("click", event => { if (event.target.hasAttribute("data-close-modal")) closeModal(); });
  }
  function closeModal() { $("#modalRoot").innerHTML = ""; }

  function submissionForm(row = null) {
    if (!state.clients.length || !state.journals.length) {
      openModal("New Submission", `<div class="notice error">Add at least one client and one journal before creating a submission.</div><p class="form-note">You can use the Clients and Journals tabs above, then return here.</p>`);
      return;
    }
    const editing = Boolean(row);
    const clientOptions = state.clients.map(c => `<option value="${esc(c.id)}" ${row?.client_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    const journalOptions = state.journals.map(j => `<option value="${esc(j.id)}" ${row?.journal_id === j.id ? "selected" : ""}>${esc(j.name)}</option>`).join("");
    const selectOptions = (items, selected) => `<option value="">Not Set</option>${items.map(v => `<option ${selected === v ? "selected" : ""}>${esc(v)}</option>`).join("")}`;
    const body = `<form id="submissionForm" class="form-grid">
      <label class="required">Client Name<select id="sClient" required>${clientOptions}</select></label>
      <label class="required">Paper Title<input id="sPaper" required value="${esc(row?.paper_title || "")}" placeholder="Enter paper title"></label>
      <label class="required">Journal Name<select id="sJournal" required>${journalOptions}</select></label>
      <label class="required">Submission Date<input id="sDate" type="date" required value="${esc(row?.submission_date || today())}"></label>
      <label>Submission ID<input id="sSubmissionId" value="${esc(row?.submission_id || "")}" placeholder="Optional"></label>
      <label>Journal Quartile<select id="sQuartile">${selectOptions(QUARTILES, row?.journal_quartile || "")}</select></label>
      <label>Indexing<select id="sIndexing">${selectOptions(INDEXING, row?.indexing || "")}</select></label>
      <label>APC (₹)<input id="sApc" inputmode="decimal" value="${esc(row?.apc ?? "")}" placeholder="Optional numeric amount"></label>
      <label>Current Status<select id="sStatus">${selectOptions(STATUSES, row?.current_status || (editing ? "" : "Submitted"))}</select></label>
      <label>Journal Username<input id="sJournalUsername" value="${esc(row?.journal_username || "")}" placeholder="Optional journal login username"></label>
      <label>Journal Password<input id="sJournalPassword" type="password" value="${esc(row?.journal_password || "")}" placeholder="Optional journal login password" autocomplete="off"></label>
      <label>Corresponding Author<input id="sAuthor" value="${esc(row?.corresponding_author || "")}" placeholder="Optional"></label>
      <label>Email<input id="sEmail" type="email" value="${esc(row?.email || "")}" placeholder="Optional"></label>
      <label>Last Updated<input id="sLastUpdated" type="date" value="${esc(row?.last_updated || (editing ? "" : today()))}"></label>
      <label class="span-2">Remarks<textarea id="sRemarks" placeholder="Optional notes, reviewer assignment, reminders...">${esc(row?.remarks || "")}</textarea></label>
      <div class="span-2 form-note">Fields marked * are required. Submission ID, quartile, indexing, APC, current status, author, email, remarks and last updated may be left blank.</div>
    </form>`;
    const foot = `<button class="btn" data-close type="button">Cancel</button><button class="btn accent" id="saveSubmissionBtn" type="button">${editing ? "Save Changes" : "Save Submission"}</button>`;
    openModal(editing ? "Edit Submission" : "New Submission", body, foot);
    $("#saveSubmissionBtn").addEventListener("click", () => saveSubmission(row));
  }

  async function saveSubmission(existing) {
    const get = id => $(id).value.trim();
    const clientId = get("#sClient"), journalId = get("#sJournal"), paper = get("#sPaper"), date = get("#sDate");
    if (!clientId || !journalId || !paper || !date) { toast("Client Name, Paper Title, Journal Name and Submission Date are required.", "error"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast("Please use a valid Submission Date.", "error"); return; }
    const email = get("#sEmail");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Please enter a valid email address or leave Email blank.", "error"); return; }
    const apcText = get("#sApc").replace(/₹/g, "").replace(/,/g, "");
    let apc = null;
    if (apcText) {
      apc = Number(apcText);
      if (!Number.isFinite(apc) || apc < 0) { toast("APC must be a valid non-negative number.", "error"); return; }
    }
    const payload = {
      client_id: clientId,
      paper_title: paper,
      journal_id: journalId,
      submission_date: date,
      submission_id: get("#sSubmissionId") || null,
      journal_quartile: get("#sQuartile") || null,
      indexing: get("#sIndexing") || null,
      apc,
      current_status: get("#sStatus") || null,
      journal_username: get("#sJournalUsername") || null,
      journal_password: get("#sJournalPassword") || null,
      corresponding_author: get("#sAuthor") || null,
      email: email || null,
      remarks: get("#sRemarks") || null,
      last_updated: get("#sLastUpdated") || null,
      updated_at: isoNow()
    };
    const oldStatus = existing?.current_status || null;
    try {
      if (existing) {
        await updateRecord("submissions", existing.id, payload);
        if (oldStatus !== payload.current_status && payload.current_status) await addHistory(existing.id, payload.current_status, "Status updated");
      } else {
        const created = await insertRecord("submissions", { id: makeId("sub"), ...payload });
        if (payload.current_status) await addHistory(created.id, payload.current_status, "Submission created");
      }
      closeModal();
      render();
      toast(existing ? "Submission updated successfully." : "Submission saved successfully.", "success");
    } catch (error) {
      toast(friendlyError(error), "error");
    }
  }

  function clientForm(row = null) {
    const body = `<form id="clientForm" class="form-grid">
      <label class="required">Client Name<input id="cName" required value="${esc(row?.name || "")}" placeholder="Client name"></label>
      <label>Phone<input id="cPhone" value="${esc(row?.phone || "")}" placeholder="Contact number"></label>
      <label>Email<input id="cEmail" type="email" value="${esc(row?.email || "")}" placeholder="Email address"></label>
      <label>Organization / Institution<input id="cOrg" value="${esc(row?.organization || "")}" placeholder="Optional"></label>
      <label class="span-2">Notes<textarea id="cNotes" placeholder="Optional client notes">${esc(row?.notes || "")}</textarea></label>
    </form>`;
    openModal(row ? "Edit Client" : "Add Client", body, `<button class="btn" data-close type="button">Cancel</button><button class="btn accent" id="saveClientBtn" type="button">Save</button>`);
    $("#saveClientBtn").addEventListener("click", () => saveClient(row));
  }

  async function saveClient(existing) {
    const name = $("#cName").value.trim(), email = $("#cEmail").value.trim();
    if (!name) { toast("Client Name is required.", "error"); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Please enter a valid client email.", "error"); return; }
    const payload = { name, phone: $("#cPhone").value.trim() || null, email: email || null, organization: $("#cOrg").value.trim() || null, notes: $("#cNotes").value.trim() || null };
    try {
      if (existing) await updateRecord("clients", existing.id, payload);
      else await insertRecord("clients", { id: makeId("client"), created_at: isoNow(), ...payload });
      closeModal(); render(); toast(existing ? "Client updated." : "Client added.", "success");
    } catch (error) { toast(friendlyError(error), "error"); }
  }

  function journalForm(row = null) {
    const selectOptions = (items, selected) => `<option value="">Not Set</option>${items.map(v => `<option ${selected === v ? "selected" : ""}>${esc(v)}</option>`).join("")}`;
    const body = `<form id="journalForm" class="form-grid">
      <label class="required">Journal Name<input id="jName" required value="${esc(row?.name || "")}" placeholder="Journal name"></label>
      <label>Publisher<input id="jPublisher" value="${esc(row?.publisher || "")}" placeholder="Publisher"></label>
      <label>ISSN<input id="jIssn" value="${esc(row?.issn || "")}" placeholder="ISSN"></label>
      <label>E-ISSN<input id="jEissn" value="${esc(row?.eissn || "")}" placeholder="E-ISSN"></label>
      <label>Indexing<select id="jIndexing">${selectOptions(INDEXING, row?.indexing || "")}</select></label>
      <label>Quartile<select id="jQuartile">${selectOptions(QUARTILES, row?.quartile || "")}</select></label>
      <label>APC (₹)<input id="jApc" inputmode="decimal" value="${esc(row?.apc ?? "")}" placeholder="Optional numeric amount"></label>
      <label>Website<input id="jWebsite" type="url" value="${esc(row?.website || "")}" placeholder="https://..."></label>
      <label>Submission URL<input id="jSubmissionUrl" type="url" value="${esc(row?.submission_url || "")}" placeholder="Journal submission portal"></label>
      <label class="span-2">Notes<textarea id="jNotes" placeholder="Optional notes">${esc(row?.notes || "")}</textarea></label>
    </form>`;
    openModal(row ? "Edit Journal" : "Add Journal", body, `<button class="btn" data-close type="button">Cancel</button><button class="btn accent" id="saveJournalBtn" type="button">Save</button>`);
    $("#saveJournalBtn").addEventListener("click", () => saveJournal(row));
  }

  async function saveJournal(existing) {
    const name = $("#jName").value.trim();
    if (!name) { toast("Journal Name is required.", "error"); return; }
    const apcText = $("#jApc").value.trim().replace(/₹/g, "").replace(/,/g, "");
    let apc = null;
    if (apcText) { apc = Number(apcText); if (!Number.isFinite(apc) || apc < 0) { toast("Journal APC must be a valid non-negative number.", "error"); return; } }
    const payload = {
      name, publisher: $("#jPublisher").value.trim() || null, issn: $("#jIssn").value.trim() || null,
      eissn: $("#jEissn").value.trim() || null, indexing: $("#jIndexing").value.trim() || null,
      quartile: $("#jQuartile").value.trim() || null, apc,
      website: $("#jWebsite").value.trim() || null, submission_url: $("#jSubmissionUrl").value.trim() || null,
      notes: $("#jNotes").value.trim() || null
    };
    try {
      if (existing) await updateRecord("journals", existing.id, payload);
      else await insertRecord("journals", { id: makeId("journal"), created_at: isoNow(), ...payload });
      closeModal(); render(); toast(existing ? "Journal updated." : "Journal added.", "success");
    } catch (error) { toast(friendlyError(error), "error"); }
  }

  function viewSubmission(row) {
    const client = clientById(row.client_id), journal = journalById(row.journal_id);
    const history = state.history.filter(h => h.submission_id === row.id).sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)));
    const fields = [
      ["Client Name", client?.name], ["Client Phone", client?.phone], ["Client Email", client?.email], ["Organization", client?.organization],
      ["Paper Title", row.paper_title], ["Journal Name", journal?.name], ["Publisher", journal?.publisher], ["Submission Date", fmtDate(row.submission_date)],
      ["Submission ID", row.submission_id], ["Journal Quartile", row.journal_quartile], ["Indexing", row.indexing], ["APC", formatApc(row.apc)],
      ["Current Status", row.current_status || "Not Set"], ["Journal Username", row.journal_username], ["Journal Password", row.journal_password],
      ["Corresponding Author", row.corresponding_author], ["Email", row.email],
      ["Last Updated", fmtDate(row.last_updated)], ["Remarks", row.remarks]
    ];
    const body = `<div class="detail-grid">${fields.map(([label,value]) => `<div class="detail-item"><div class="detail-label">${esc(label)}</div><div class="detail-value">${esc(value || "—")}</div></div>`).join("")}</div>
      <div style="margin-top:14px;color:var(--header);font-weight:700;font-size:13px">Status History</div>
      <div class="history">${history.length ? history.map(h => `<div class="history-item"><div class="history-date">${fmtDate(h.created_at)}<br>${esc(new Date(h.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}))}</div><div class="history-body"><b>${esc(h.status)}</b>${h.note ? `<div class="table-sub">${esc(h.note)}</div>` : ""}</div></div>`).join("") : `<div class="empty">No status history yet.</div>`}</div>`;
    openModal("Submission Details", body, `<button class="btn accent" data-close type="button">Close</button>`);
  }

  function exportData(rows, filename, sheetName = "Submissions", summary = null) {
    if (!window.XLSX) { toast("Excel library is not available. Check your internet connection.", "error"); return; }
    if (!rows.length) { toast("No records match this export.", "error"); return; }
    const out = rows.map(toExportObject);
    const wb = window.XLSX.utils.book_new();
    const ws = window.XLSX.utils.json_to_sheet(out);
    ws["!cols"] = autoWidths(out);
    window.XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
    if (summary) {
      const sw = window.XLSX.utils.aoa_to_sheet(summary);
      sw["!cols"] = [{ wch: 26 }, { wch: 30 }];
      window.XLSX.utils.book_append_sheet(wb, sw, "Summary");
    }
    window.XLSX.writeFile(wb, filename);
    toast("Excel file exported successfully.", "success");
  }

  function autoWidths(rows) {
    if (!rows.length) return [];
    return Object.keys(rows[0]).map(key => ({ wch: Math.min(48, Math.max(12, Math.max(key.length, ...rows.slice(0, 100).map(r => String(r[key] ?? "").length)) + 2)) }));
  }

  function toExportObject(row) {
    const client = clientById(row.client_id), journal = journalById(row.journal_id);
    return {
      "Database Record ID": row.id,
      "Client Name": client?.name || "",
      "Client Phone": client?.phone || "",
      "Client Email": client?.email || "",
      "Organization / Institution": client?.organization || "",
      "Paper Title": row.paper_title || "",
      "Journal Name": journal?.name || "",
      "Publisher": journal?.publisher || "",
      "ISSN": journal?.issn || "",
      "E-ISSN": journal?.eissn || "",
      "Submission Date": row.submission_date || "",
      "Submission ID": row.submission_id || "",
      "Journal Quartile": row.journal_quartile || "",
      "Indexing": row.indexing || "",
      "APC (₹)": row.apc ?? "",
      "Current Status": row.current_status || "Not Set",
      "Journal Username": row.journal_username || "",
      "Journal Password": row.journal_password || "",
      "Corresponding Author": row.corresponding_author || "",
      "Email": row.email || "",
      "Remarks": row.remarks || "",
      "Last Updated": row.last_updated || ""
    };
  }

  function exportSummary(rows, heading, value) {
    const counts = {};
    rows.forEach(r => { const key = r.current_status || "Not Set"; counts[key] = (counts[key] || 0) + 1; });
    return [[heading, value], ["Records", rows.length], [], ["Status", "Count"], ...Object.entries(counts).sort((a,b)=>b[1]-a[1])];
  }

  function promptClientExport() {
    if (!state.clients.length) { toast("Add a client before using client-wise export.", "error"); return; }
    const body = `<label class="required">Select Client<select id="exportClientSelect"><option value="">Select a client</option>${state.clients.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></label><div class="form-note" style="margin-top:8px">Only submissions belonging to the selected client will be exported.</div>`;
    openModal("Client-wise Export", body, `<button class="btn" data-close type="button">Cancel</button><button class="btn accent" id="runClientExport" type="button">Export</button>`);
    $("#runClientExport").addEventListener("click", () => {
      const clientId = $("#exportClientSelect").value;
      if (!clientId) { toast("Please select a client.", "error"); return; }
      const client = clientById(clientId);
      const rows = state.submissions.filter(s => s.client_id === clientId);
      closeModal();
      exportData(rows, `client_${cleanFile(client?.name)}.xlsx`, "Client Submissions", exportSummary(rows, "Client", client?.name || ""));
    });
  }

  function promptDateExport() {
    const body = `<div class="form-grid"><label>From Date<input id="exportFrom" type="date"></label><label>To Date<input id="exportTo" type="date"></label></div><div class="form-note" style="margin-top:9px">Enter at least one date. If both are entered, the range is inclusive.</div>`;
    openModal("Date-wise Export", body, `<button class="btn" data-close type="button">Cancel</button><button class="btn accent" id="runDateExport" type="button">Export</button>`);
    $("#runDateExport").addEventListener("click", () => {
      const from = $("#exportFrom").value, to = $("#exportTo").value;
      if (!from && !to) { toast("Enter a From date, To date, or both.", "error"); return; }
      if (from && to && from > to) { toast("From Date cannot be later than To Date.", "error"); return; }
      const rows = state.submissions.filter(s => (!from || s.submission_date >= from) && (!to || s.submission_date <= to));
      closeModal();
      const name = `datewise_${from || "start"}_${to || "end"}.xlsx`;
      exportData(rows, name, "Date-wise Submissions", exportSummary(rows, "Date range", `${from || "Any"} to ${to || "Any"}`));
    });
  }

  function promptStatusExport() {
    const body = `<label class="required">Select Status<select id="exportStatusSelect"><option value="">Select a status</option><option value="__NOT_SET__">Not Set</option>${STATUSES.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select></label><div class="form-note" style="margin-top:8px">Only submissions with the selected current status will be exported.</div>`;
    openModal("Status-wise Export", body, `<button class="btn" data-close type="button">Cancel</button><button class="btn accent" id="runStatusExport" type="button">Export</button>`);
    $("#runStatusExport").addEventListener("click", () => {
      const status = $("#exportStatusSelect").value;
      if (!status) { toast("Please select a status.", "error"); return; }
      const rows = state.submissions.filter(s => status === "__NOT_SET__" ? !s.current_status : s.current_status === status);
      closeModal();
      const label = status === "__NOT_SET__" ? "Not_Set" : cleanFile(status);
      exportData(rows, `status_${label}.xlsx`, "Status-wise Submissions", exportSummary(rows, "Status", status === "__NOT_SET__" ? "Not Set" : status));
    });
  }

  function exportAll() {
    const rows = state.submissions.slice().sort((a,b)=>String(b.submission_date || "").localeCompare(String(a.submission_date || "")));
    exportData(rows, `all_submissions_${today()}.xlsx`, "All Submissions", exportSummary(rows, "Export", "All records"));
  }

  function exportCurrentFilter() {
    exportData(filteredSubmissions(), `current_filter_${today()}.xlsx`, "Filtered Submissions", exportSummary(filteredSubmissions(), "Export", "Current submission filters"));
  }

  function importKey(value) {
    return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function excelDateToIso(value) {
    if (value === null || value === undefined || value === "") return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const y = value.getFullYear(), m = String(value.getMonth() + 1).padStart(2, "0"), d = String(value.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    if (typeof value === "number" && window.XLSX?.SSF?.parse_date_code) {
      const parsed = window.XLSX.SSF.parse_date_code(value);
      if (parsed) return `${String(parsed.y).padStart(4, "0")}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
    }
    const text = String(value).trim();
    let match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (match) {
      let year = Number(match[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      return `${year}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
    }
    match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    }
    return null;
  }

  function normalizeImportedStatus(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const text = raw.toLowerCase();
    if (/publish|online first|online publication/.test(text)) return "Published";
    if (/accept/.test(text)) return "Accepted";
    if (/desk\s*reject/.test(text)) return "Desk Rejected";
    if (/reject|declin/.test(text)) return "Rejected";
    if (/withdraw/.test(text)) return "Withdrawn";
    if (/major\s*revision/.test(text)) return "Major Revision";
    if (/minor\s*revision/.test(text)) return "Minor Revision";
    if (/revis|resubmit|re-submit|return/.test(text)) return "Revised Manuscript Submitted";
    if (/under\s*review|reviewing|in\s*review|awaiting\s*(assignment|review)|with\s*editor|editor/.test(text)) return "Under Review";
    if (/submit|transfer|apc/.test(text)) return "Submitted";
    return null;
  }

  function normalizeImportedIndexing(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const lower = text.toLowerCase();
    const scopus = lower.includes("scopus");
    const wos = /web\s*of\s*science|sci\b|ssci\b|esci\b/.test(lower);
    if (scopus && wos) return "Scopus + Web of Science";
    if (scopus) return "Scopus";
    if (wos) return "Web of Science";
    if (lower.includes("ugc")) return "UGC Care";
    return "Other";
  }

  function findExcelHeaderRow(rows, requiredHeader) {
    const target = importKey(requiredHeader);
    for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
      if ((rows[i] || []).some(cell => importKey(cell) === target)) return i;
    }
    return -1;
  }

  function headerIndexMap(header) {
    const map = {};
    (header || []).forEach((cell, index) => { if (cell !== null && cell !== undefined && String(cell).trim()) map[importKey(cell)] = index; });
    return map;
  }

  function rowValue(row, map, ...names) {
    for (const name of names) {
      const idx = map[importKey(name)];
      if (idx !== undefined) {
        const value = row[idx];
        if (value !== null && value !== undefined && String(value).trim() !== "") return value;
      }
    }
    return null;
  }

  function namesLikelyMatch(a, b) {
    const x = importKey(a), y = importKey(b);
    if (!x || !y) return false;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    if (Math.abs(x.length - y.length) > 2) return false;
    const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
    for (let j = 0; j <= y.length; j += 1) dp[0][j] = j;
    for (let i = 1; i <= x.length; i += 1) {
      for (let j = 1; j <= y.length; j += 1) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      }
    }
    return dp[x.length][y.length] <= 2;
  }

  async function getOrCreateImportedClient(name, email = null) {
    const cleaned = String(name || "").trim();
    if (!cleaned) return null;
    let client = state.clients.find(c => namesLikelyMatch(c.name, cleaned));
    if (client) {
      if (!client.email && email) await updateRecord("clients", client.id, { email: String(email).trim() });
      return clientById(client.id);
    }
    return insertRecord("clients", { id: makeId("client"), created_at: isoNow(), name: cleaned, phone: null, email: email ? String(email).trim() : null, organization: null, notes: null });
  }

  async function getOrCreateImportedJournal(name, details = {}) {
    const cleaned = String(name || "").trim();
    if (!cleaned) return null;
    let journal = state.journals.find(j => importKey(j.name) === importKey(cleaned));
    const patch = {};
    if (journal) {
      if (!journal.indexing && details.indexing) patch.indexing = details.indexing;
      if (!journal.quartile && details.quartile) patch.quartile = details.quartile;
      if (!journal.website && details.website) patch.website = details.website;
      if (Object.keys(patch).length) await updateRecord("journals", journal.id, patch);
      return journalById(journal.id);
    }
    return insertRecord("journals", {
      id: makeId("journal"), created_at: isoNow(), name: cleaned, publisher: null, issn: null, eissn: null,
      indexing: details.indexing || null, quartile: details.quartile || null, apc: null,
      website: details.website || null, submission_url: null, notes: null
    });
  }

  function importedSubmissionMatch(clientId, journalId, title, date) {
    const titleKey = importKey(title);
    return state.submissions.find(s => s.client_id === clientId && s.journal_id === journalId && importKey(s.paper_title) === titleKey && String(s.submission_date || "") === String(date || ""));
  }

  async function importRegularSheet(sheetName, rows, stats) {
    const headerRow = findExcelHeaderRow(rows, "Journal Name");
    if (headerRow < 0) return;
    const map = headerIndexMap(rows[headerRow]);
    if (map[importKey("Client Name")] !== undefined) return;

    const clientEmail = rows.slice(headerRow + 1).map(row => rowValue(row, map, "Email")).find(Boolean) || null;
    const client = await getOrCreateImportedClient(sheetName, clientEmail);
    if (!client) return;
    stats.clients.add(client.id);

    for (const row of rows.slice(headerRow + 1)) {
      const journalName = rowValue(row, map, "Journal Name");
      const paperTitle = rowValue(row, map, "Title of Paper", "Paper Title");
      const submissionDate = excelDateToIso(rowValue(row, map, "Submission Date", "Submission date"));
      const rawStatus = rowValue(row, map, "Status", "Current Status");
      if (!journalName || (!paperTitle && !submissionDate && !rawStatus)) continue;

      const quartileRaw = String(rowValue(row, map, "Quartile") || "").trim().toUpperCase();
      const quartile = ["Q1", "Q2", "Q3", "Q4"].includes(quartileRaw.replace(/\s+/g, "")) ? quartileRaw.replace(/\s+/g, "") : null;
      const indexing = normalizeImportedIndexing(rowValue(row, map, "Journal Level", "Indexing"));
      const website = rowValue(row, map, "Journal Link", "Website");
      const journal = await getOrCreateImportedJournal(journalName, { indexing, quartile, website: website ? String(website).trim() : null });
      if (!journal) continue;

      const status = normalizeImportedStatus(rawStatus);
      const email = rowValue(row, map, "Email");
      const journalUsername = rowValue(row, map, "Username", "User Name", "Journal Username");
      const journalPassword = rowValue(row, map, "Password", "Journal Password");
      const remarks = rowValue(row, map, "Remarks");
      const title = String(paperTitle || journalName).trim();
      const existing = importedSubmissionMatch(client.id, journal.id, title, submissionDate);
      const payload = {
        client_id: client.id, paper_title: title, journal_id: journal.id, submission_date: submissionDate,
        submission_id: null, journal_quartile: quartile, indexing, apc: null, current_status: status,
        journal_username: journalUsername ? String(journalUsername).trim() : null,
        journal_password: journalPassword ? String(journalPassword).trim() : null,
        corresponding_author: null, email: email ? String(email).trim() : null,
        remarks: remarks ? String(remarks).trim() : null, last_updated: null, updated_at: isoNow()
      };

      if (existing) {
        const patch = {};
        if (status && existing.current_status !== status) patch.current_status = status;
        if (!existing.journal_quartile && quartile) patch.journal_quartile = quartile;
        if (!existing.indexing && indexing) patch.indexing = indexing;
        if (!existing.email && payload.email) patch.email = payload.email;
        if (!existing.journal_username && payload.journal_username) patch.journal_username = payload.journal_username;
        if (!existing.journal_password && payload.journal_password) patch.journal_password = payload.journal_password;
        if (!existing.remarks && payload.remarks) patch.remarks = payload.remarks;
        if (Object.keys(patch).length) { await updateRecord("submissions", existing.id, patch); stats.updated += 1; }
        else stats.skipped += 1;
      } else {
        await insertRecord("submissions", { id: makeId("sub"), ...payload });
        stats.imported += 1;
      }
    }
  }

  async function applyAcceptedSheet(rows, stats) {
    const headerRow = findExcelHeaderRow(rows, "Client Name");
    if (headerRow < 0) return;
    const map = headerIndexMap(rows[headerRow]);
    for (const row of rows.slice(headerRow + 1)) {
      const clientName = rowValue(row, map, "Client Name");
      if (!clientName) continue;
      const journalName = rowValue(row, map, "Journal Name");
      const client = state.clients.find(c => namesLikelyMatch(c.name, clientName)) || await getOrCreateImportedClient(clientName);
      if (!client) continue;
      stats.clients.add(client.id);

      let candidates = state.submissions.filter(s => s.client_id === client.id);
      if (journalName) {
        const matchingJournals = state.journals.filter(j => importKey(j.name) === importKey(journalName) || importKey(j.name).includes(importKey(journalName)) || importKey(journalName).includes(importKey(j.name)));
        const ids = new Set(matchingJournals.map(j => j.id));
        const matched = candidates.filter(s => ids.has(s.journal_id));
        if (matched.length) candidates = matched;
      }
      candidates.sort((a, b) => String(b.submission_date || "").localeCompare(String(a.submission_date || "")));
      if (candidates.length) {
        const target = candidates[0];
        if (target.current_status !== "Accepted" && target.current_status !== "Published") {
          await updateRecord("submissions", target.id, { current_status: "Accepted", updated_at: isoNow() });
          stats.accepted += 1;
        }
        continue;
      }

      if (journalName) {
        const journalLink = rowValue(row, map, "Journal Link");
        const journal = await getOrCreateImportedJournal(journalName, { website: journalLink ? String(journalLink).trim() : null });
        const submissionDate = excelDateToIso(rowValue(row, map, "Submission date", "Submission Date"));
        await insertRecord("submissions", {
          id: makeId("sub"), client_id: client.id, paper_title: `Accepted paper - ${String(journalName).trim()}`,
          journal_id: journal.id, submission_date: submissionDate, submission_id: null, journal_quartile: null,
          indexing: journal.indexing || null, apc: null, current_status: "Accepted", journal_username: null, journal_password: null, corresponding_author: null,
          email: client.email || null, remarks: "Imported from Accepted Jouornals sheet", last_updated: excelDateToIso(rowValue(row, map, "Acceptance date", "Acceptance Date")), updated_at: isoNow()
        });
        stats.imported += 1;
        stats.accepted += 1;
      }
    }
  }

  async function importExcelFile(file) {
    if (!file || !window.XLSX) { toast("Excel library is not available. Check your internet connection.", "error"); return; }
    const button = $("#excelImportBtn");
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Importing...";
    try {
      const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const sheets = workbook.SheetNames.map(name => ({ name, rows: window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null }) }));
      const stats = { clients: new Set(), imported: 0, updated: 0, skipped: 0, accepted: 0 };

      for (const sheet of sheets) {
        const headerRow = findExcelHeaderRow(sheet.rows, "Client Name");
        if (headerRow >= 0) continue;
        await importRegularSheet(sheet.name.trim(), sheet.rows, stats);
      }
      for (const sheet of sheets) {
        const headerRow = findExcelHeaderRow(sheet.rows, "Client Name");
        if (headerRow >= 0) await applyAcceptedSheet(sheet.rows, stats);
      }

      state.view = "dashboard";
      render();
      toast(`Excel imported: ${stats.clients.size} clients, ${stats.imported} papers added, ${stats.updated} updated.`, "success");
    } catch (error) {
      toast(`Excel import failed: ${friendlyError(error)}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
      $("#excelImportInput").value = "";
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
  }

  function openSecureBackupModal() {
    const body = `<p class="form-note" style="margin:0 0 12px">The backup is encrypted locally with AES-GCM using a password-derived key. Keep the password safe; it is not stored by this application.</p>
      <div class="form-grid"><label class="required">Backup Password<input id="backupPassword" type="password" minlength="8" autocomplete="new-password"></label><label class="required">Confirm Password<input id="backupPassword2" type="password" minlength="8" autocomplete="new-password"></label></div>`;
    openModal("Create Encrypted Backup", body, `<button class="btn" data-close type="button">Cancel</button><button class="btn accent" id="runBackup" type="button">Create Backup</button>`);
    $("#runBackup").addEventListener("click", createEncryptedBackup);
  }

  async function createEncryptedBackup() {
    const password = $("#backupPassword").value;
    const confirm = $("#backupPassword2").value;
    if (password.length < 8) { toast("Backup password must be at least 8 characters.", "error"); return; }
    if (password !== confirm) { toast("Backup passwords do not match.", "error"); return; }
    if (!window.crypto?.subtle) { toast("Secure browser encryption is unavailable in this browser.", "error"); return; }
    const payload = {
      application: "Journal Submission Manager",
      version: 3,
      exported_at: isoNow(),
      clients: state.clients,
      journals: state.journals,
      submissions: state.submissions,
      status_history: state.history
    };
    try {
      const enc = new TextEncoder();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({ name:"PBKDF2", salt, iterations:250000, hash:"SHA-256" }, baseKey, { name:"AES-GCM", length:256 }, false, ["encrypt"]);
      const ciphertext = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
      const backup = JSON.stringify({
        format: "JSM-Encrypted-Backup",
        version: 1,
        kdf: "PBKDF2-SHA-256",
        iterations: 250000,
        cipher: "AES-256-GCM",
        salt: arrayBufferToBase64(salt),
        iv: arrayBufferToBase64(iv),
        ciphertext: arrayBufferToBase64(ciphertext)
      });
      const blob = new Blob([backup], { type:"application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `journal_submission_encrypted_backup_${today()}.jsmbackup`;
      a.click();
      URL.revokeObjectURL(url);
      closeModal();
      toast("Encrypted backup downloaded.", "success");
    } catch (error) {
      toast(`Backup failed: ${friendlyError(error)}`, "error");
    }
  }

  function bindViewEvents() {
    const container = $("#viewContainer");
    container.onclick = async event => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      const id = button.dataset.id;
      try {
        if (action === "new-sub") submissionForm();
        else if (action === "edit-sub") { const row = state.submissions.find(r => r.id === id); if (row) submissionForm(row); }
        else if (action === "view-sub") { const row = state.submissions.find(r => r.id === id); if (row) viewSubmission(row); }
        else if (action === "delete-sub") await deleteSubmission(id);
        else if (action === "new-client") clientForm();
        else if (action === "edit-client") { const row = clientById(id); if (row) clientForm(row); }
        else if (action === "new-journal") journalForm();
        else if (action === "edit-journal") { const row = journalById(id); if (row) journalForm(row); }
        else if (action === "filter-sub") applyFiltersFromUi();
        else if (action === "clear-filters") { state.filters = { search:"", client:"", status:"", from:"", to:"" }; render(); }
        else if (action === "export-filter") exportCurrentFilter();
        else if (action === "export-all") exportAll();
        else if (action === "export-client") promptClientExport();
        else if (action === "export-date") promptDateExport();
        else if (action === "export-status") promptStatusExport();
        else if (action === "backup-json") openSecureBackupModal();
      } catch (error) { toast(friendlyError(error), "error"); }
    };

    const search = $("#fSearch");
    if (search) search.addEventListener("keydown", event => { if (event.key === "Enter") applyFiltersFromUi(); });
  }

  function applyFiltersFromUi() {
    state.filters = {
      search: $("#fSearch")?.value.trim() || "",
      client: $("#fClient")?.value || "",
      status: $("#fStatus")?.value || "",
      from: $("#fFrom")?.value || "",
      to: $("#fTo")?.value || ""
    };
    if (state.filters.from && state.filters.to && state.filters.from > state.filters.to) { toast("From date cannot be later than To date.", "error"); return; }
    render();
  }

  async function deleteSubmission(id) {
    const row = state.submissions.find(s => s.id === id);
    if (!row) return;
    const journal = journalById(row.journal_id);
    const ok = window.confirm(`Delete this submission?\n\n${row.paper_title}\n${journal?.name || ""}\n\nIts status history will also be deleted.`);
    if (!ok) return;
    const historyToDelete = state.history.filter(h => h.submission_id === id);
    for (const h of historyToDelete) {
      await deleteDoc(doc(userCollection("history"), h.id));
    }
    await deleteRecord("submissions", id);
    state.history = state.history.filter(h => h.submission_id !== id);
    render();
    toast("Submission deleted.", "success");
  }

  function friendlyError(error) {
    const code = String(error?.code || "");
    const message = String(error?.message || error || "Unexpected error");
    const known = {
      "auth/invalid-credential": "Incorrect email or password.",
      "auth/invalid-email": "Please enter a valid email address.",
      "auth/user-disabled": "This account has been disabled. Contact the administrator.",
      "auth/too-many-requests": "Too many sign-in attempts. Please wait and try again later.",
      "auth/network-request-failed": "Network error. Check your internet connection and try again.",
      "auth/operation-not-allowed": "Email/password sign-in is not enabled in Firebase Authentication.",
      "auth/weak-password": "Password is too weak. Use a stronger password.",
      "auth/expired-action-code": "This password-reset link has expired. Request a new one.",
      "auth/invalid-action-code": "This password-reset link is invalid or has already been used.",
      "auth/user-not-found": "No account was found for this email address."
    };
    if (known[code]) return known[code];
    if (/permission-denied|Missing or insufficient permissions/i.test(message)) return "This action was blocked by Firestore security rules. Check firebase/firestore.rules.";
    if (/already-exists|ALREADY_EXISTS|duplicate/i.test(message)) return "A record with this ID already exists. Please try again.";
    return message;
  }

  async function forgotPassword() {
    if (!auth) { toast("Configure Firebase first.", "error"); return; }
    const email = $("#loginEmail").value.trim();
    if (!email) { toast("Enter your account email first.", "error"); return; }
    try {
      const redirectUrl = `${window.location.origin}${window.location.pathname}`;
      await sendPasswordResetEmail(auth, email, {
        url: redirectUrl,
        handleCodeInApp: true
      });
      showAuth("Password reset email sent. Open the email and use the link to set a new password.", "success");
    } catch (error) { showAuth(friendlyError(error), "error"); }
  }

  async function login(event) {
    event.preventDefault();
    if (!auth || authBusy) return;
    const email = $("#loginEmail").value.trim(), password = $("#loginPassword").value;
    if (!email || !password) return;
    authBusy = true;
    const button = $("#loginForm button[type=submit]");
    button.disabled = true;
    button.textContent = "Signing in...";
    try {
      await signInWithEmailAndPassword(auth, email, password);
      toast("Signed in successfully.", "success");
    } catch (error) {
      showAuth(friendlyError(error), "error");
    } finally {
      authBusy = false;
      button.disabled = !hasConfig;
      button.textContent = "Sign in";
    }
  }

  async function updatePassword(event) {
    event.preventDefault();
    if (!auth || !resetCode) return;
    const newPassword = $("#newPassword").value;
    const confirm = $("#confirmPassword").value;
    if (newPassword.length < 8) { toast("Password must be at least 8 characters.", "error"); return; }
    if (newPassword !== confirm) { toast("Passwords do not match.", "error"); return; }
    try {
      await confirmPasswordReset(auth, resetCode, newPassword);
      resetCode = null;
      $("#newPassword").value = "";
      $("#confirmPassword").value = "";
      history.replaceState({}, document.title, window.location.pathname);
      showAuth("Password updated successfully. You can now sign in with your new password.", "success");
    } catch (error) {
      showReset(friendlyError(error), "error");
    }
  }

  async function signOutUser() {
    if (!auth) return;
    try {
      await signOut(auth);
      session = null;
      state.clients = []; state.journals = []; state.submissions = []; state.history = [];
      showAuth();
      $("#loginPassword").value = "";
      toast("Signed out.", "success");
    } catch (error) { toast(friendlyError(error), "error"); }
  }

  async function start() {
    renderConfigState();
    $("#loginForm").addEventListener("submit", login);
    $("#forgotPasswordBtn").addEventListener("click", forgotPassword);
    $("#resetForm").addEventListener("submit", updatePassword);
    $("#backToLoginBtn").addEventListener("click", () => showAuth());
    $("#signOutBtn").addEventListener("click", signOutUser);
    $("#excelImportBtn").addEventListener("click", () => $("#excelImportInput").click());
    $("#excelImportInput").addEventListener("change", event => importExcelFile(event.target.files?.[0]));
    $("#backupBtn").addEventListener("click", openSecureBackupModal);
    $("#mainNav").addEventListener("click", event => {
      const tab = event.target.closest("[data-view]");
      if (!tab) return;
      state.view = tab.dataset.view;
      render();
    });

    if (!hasConfig) { showAuth(); return; }

    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    const code = params.get("oobCode");
    if (mode === "resetPassword" && code) {
      try {
        await verifyPasswordResetCode(auth, code);
        resetCode = code;
        showReset();
      } catch (error) {
        showAuth(friendlyError(error), "error");
      }
    }

    onAuthStateChanged(auth, async user => {
      session = user ? { user } : null;
      if (!user) {
        state.clients = []; state.journals = []; state.submissions = []; state.history = [];
        if (!resetCode) showAuth();
        return;
      }
      if (resetCode) return;
      try {
        await loadCloud();
        showApp();
        render();
      } catch (error) {
        showAuth(friendlyError(error), "error");
      }
    });
  }

  start();
})();
