/**
 * Render a self-contained HTML design-inventory review page from findings.json documents.
 *
 * Reads one or more findings.json files (or directories containing them), validates
 * each with validateFindings, and writes a single standalone HTML file with inline
 * CSS and vanilla JS. The page lets a reviewer accept or decline findings and themes,
 * then export a decisions.json.
 *
 * Usage:
 *     node render-review-html.mjs --findings PATH [--findings PATH ...]
 *         --out review.html [--screenshots-dir DIR] [--title TITLE]
 *
 * Exit codes: 0 ok, 1 error.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { FINDING_CATEGORIES, INTENTS, validateFindings, type JsonObject } from "./design-findings-schema.js";
import { runWhenMain } from "./cli.js";

const MAX_SCREENSHOTS = 12;
const MAX_SCREENSHOT_BYTES = 300_000;

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

function loadFindingsFiles(paths: string[]): Array<[string, JsonObject]> | null {
  const collected: Array<[string, JsonObject]> = [];
  for (const raw of paths) {
    let candidates: string[];
    try {
      const stat = statSync(raw);
      if (stat.isDirectory()) {
        candidates = readdirSync(raw)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => join(raw, f));
      } else {
        candidates = [raw];
      }
    } catch (exc) {
      console.error(`error: cannot access ${raw}: ${exc instanceof Error ? exc.message : String(exc)}`);
      return null;
    }

    for (const candidate of candidates) {
      let text: string;
      try {
        text = readFileSync(candidate, "utf-8");
      } catch (exc) {
        console.error(`error: cannot read ${candidate}: ${exc instanceof Error ? exc.message : String(exc)}`);
        return null;
      }
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (exc) {
        console.error(`error: invalid JSON in ${candidate}: ${exc instanceof Error ? exc.message : String(exc)}`);
        return null;
      }
      // Skip decisions documents (they have a top-level "decisions" key).
      if (typeof doc === "object" && doc !== null && !Array.isArray(doc) && "decisions" in doc) {
        continue;
      }
      collected.push([candidate, doc as JsonObject]);
    }
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Screenshot embedding
// ---------------------------------------------------------------------------

function embedScreenshots(paths: string[], screenshotsDir: string | null, budget: number): string[] {
  const uris: string[] = [];
  for (const raw of paths) {
    if (uris.length >= budget) break;
    const p = screenshotsDir !== null ? join(screenshotsDir, raw) : resolve(raw);
    let data: Buffer;
    try {
      data = readFileSync(p);
    } catch {
      continue;
    }
    if (!statSync(p, { throwIfNoEntry: false })?.isFile()) continue;
    if (data.length > MAX_SCREENSHOT_BYTES) continue;
    const ext = basename(p).split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "png" ? "image/png" : ext ? `image/${ext}` : "image/png";
    const encoded = data.toString("base64");
    uris.push(`data:${mime};base64,${encoded}`);
  }
  return uris;
}

// ---------------------------------------------------------------------------
// Intent ordering
// ---------------------------------------------------------------------------

const INTENT_ORDER: Record<string, number> = {
  unclear: 0,
  "likely-unintentional": 1,
  "likely-intentional": 2,
};

function intentRank(finding: JsonObject): number {
  const intent = finding["intent"];
  return INTENT_ORDER[typeof intent === "string" ? intent : ""] ?? 0;
}

// ---------------------------------------------------------------------------
// HTML generation helpers
// ---------------------------------------------------------------------------

function badge(text: string, cssClass = ""): string {
  const klass = cssClass ? `badge ${cssClass}` : "badge";
  return `<span class="${klass}">${escapeHtml(text)}</span>`;
}

function refsHtml(block: JsonObject): string {
  const summary = escapeHtml(String(block["summary"] ?? ""));
  const refs = Array.isArray(block["refs"]) ? (block["refs"] as unknown[]) : [];
  if (refs.length > 0) {
    const refItems = refs.map((r) => `<li><code>${escapeHtml(String(r))}</code></li>`).join("");
    return `<span class="refs-summary">${summary}</span><ul class="refs">${refItems}</ul>`;
  }
  return `<span class="refs-summary">${summary}</span>`;
}

function reuseHtml(reuse: JsonObject | null): string {
  if (reuse === null) return "";
  const resolution = String(reuse["resolution"] ?? "not-applicable");
  if (resolution === "reuse") {
    const comp = escapeHtml(String(reuse["component"] ?? ""));
    const imp = escapeHtml(String(reuse["import_path"] ?? ""));
    return `<div class="reuse-line">Reuse: <strong>${comp}</strong> from <code>${imp}</code></div>`;
  }
  if (resolution === "new-component") {
    const proposed = escapeHtml(String(reuse["proposed_name"] ?? ""));
    const closest = escapeHtml(String(reuse["closest_existing"] ?? ""));
    const closestHtml = closest ? ` (closest: <code>${closest}</code>)` : "";
    return `<div class="reuse-line">NEW: <strong>${proposed}</strong>${closestHtml}</div>`;
  }
  return "";
}

function radioGroup(name: string, preAccept = false): string {
  const undecidedChecked = preAccept ? "" : " checked";
  const acceptChecked = preAccept ? " checked" : "";
  return (
    `<div class="radio-group" data-name="${escapeHtml(name)}">` +
    `<label class="radio-accept"><input type="radio" name="${escapeHtml(name)}" value="accepted"${acceptChecked}> Accept</label>` +
    `<label class="radio-decline"><input type="radio" name="${escapeHtml(name)}" value="declined"> Decline</label>` +
    `<label class="radio-undecided"><input type="radio" name="${escapeHtml(name)}" value="undecided"${undecidedChecked}> Undecided</label>` +
    `</div>`
  );
}


let cardShotBudget = 60;

/** Embed a captured card screenshot as a data uri (size and count capped). */
function cardShotHtml(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || cardShotBudget <= 0) return "";
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return "";
  }
  if (data.length > MAX_SCREENSHOT_BYTES) return "";
  cardShotBudget -= 1;
  const uri = `data:image/png;base64,${data.toString("base64")}`;
  return `<div class="card-shot"><img src="${uri}" alt="design region for this decision"></div>`;
}

function findingCardHtml(
  finding: JsonObject,
  unitName: string,
  includeRadios: boolean,
  insideTheme = false,
): string {
  const fid = String(finding["id"] ?? "");
  const title = String(finding["title"] ?? "");
  const category = String(finding["category"] ?? "");
  const intent = String(finding["intent"] ?? "");
  const intentRationale = String(finding["intent_rationale"] ?? "");
  const rawState = finding["state"];
  const stateBlock: JsonObject =
    typeof rawState === "object" && rawState !== null && !Array.isArray(rawState)
      ? (rawState as JsonObject)
      : { summary: "", refs: [] };
  const rawSpec = finding["spec"];
  const specBlock: JsonObject =
    typeof rawSpec === "object" && rawSpec !== null && !Array.isArray(rawSpec)
      ? (rawSpec as JsonObject)
      : { summary: "", refs: [] };
  const rawReuse = finding["reuse"];
  const reuse: JsonObject | null =
    rawReuse !== null &&
    rawReuse !== undefined &&
    typeof rawReuse === "object" &&
    !Array.isArray(rawReuse)
      ? (rawReuse as JsonObject)
      : null;
  const summary = String(finding["summary"] ?? "");
  const preAccept = intent === "likely-intentional";

  // Extract unit_id prefix from finding id: CHG-<unit-slug>-NN
  const parts = fid.split("-");
  const unitId = parts.length >= 3 ? parts.slice(1, -1).join("-") : "";

  const hiddenClass = insideTheme ? " theme-member-card" : "";
  const dataAttrs =
    ` data-unit="${escapeHtml(unitId)}"` +
    ` data-category="${escapeHtml(category)}"` +
    ` data-intent="${escapeHtml(intent)}"` +
    ` data-fid="${escapeHtml(fid)}"`;

  const lines: string[] = [
    `<div class="finding-card${hiddenClass}"${dataAttrs}>`,
    '<div class="finding-header">',
    `<span class="finding-title">${escapeHtml(title)}</span>`,
    `<span class="unit-name">${escapeHtml(unitName)}</span>`,
    badge(category, `cat-${category}`),
    `<span class="finding-id">${escapeHtml(fid)}</span>`,
    "</div>",
    cardShotHtml(finding["screenshot"]),
    `<div class="finding-intent">Intent: ${badge(intent, `intent-${intent}`)} &mdash; ${escapeHtml(intentRationale)}</div>`,
    `<div class="finding-state"><strong>State:</strong> ${refsHtml(stateBlock)}</div>`,
    `<div class="finding-spec"><strong>Spec:</strong> ${refsHtml(specBlock)}</div>`,
    reuseHtml(reuse),
    `<div class="finding-summary"><strong>${escapeHtml(summary)}</strong></div>`,
  ];
  if (includeRadios) {
    lines.push(radioGroup(fid, preAccept));
  } else if (insideTheme) {
    // Hidden until the theme's "Override per finding" checkbox is checked;
    // starts Undecided because an override is an explicit per-finding act.
    lines.push(`<div class="override-radios">${radioGroup(fid)}</div>`);
  }
  lines.push("</div>");
  return lines.join("\n");
}

function themeCardHtml(
  theme: JsonObject,
  unitName: string,
  memberFindings: JsonObject[],
): string {
  const tid = String(theme["id"] ?? "");
  const title = String(theme["title"] ?? "");

  const memberSummaries = memberFindings
    .map(
      (f) =>
        `<li>${escapeHtml(String(f["summary"] ?? ""))} <code class="member-id">${escapeHtml(String(f["id"] ?? ""))}</code></li>`,
    )
    .join("");

  const memberCards = memberFindings
    .map((f) => findingCardHtml(f, unitName, false, true))
    .join("\n");

  const overrideId = `override-${escapeHtml(tid)}`;

  // Radio name for theme: "thm-<slug>" where slug = tid without "thm-" prefix
  const radioName = tid.startsWith("thm-") ? `thm-${tid.slice(4)}` : tid;

  return (
    `<div class="theme-card" data-tid="${escapeHtml(tid)}">` +
    `<div class="theme-header">` +
    `<span class="theme-title">${escapeHtml(title)}</span>` +
    `<span class="unit-name">${escapeHtml(unitName)}</span>` +
    `<span class="theme-id">${escapeHtml(tid)}</span>` +
    `</div>` +
    cardShotHtml(theme["screenshot"]) +
    `<ul class="theme-members">${memberSummaries}</ul>` +
    radioGroup(radioName) +
    `<details class="theme-details">` +
    `<summary>Individual findings (${memberFindings.length})` +
    ` &mdash; <label class="override-label">` +
    `<input type="checkbox" class="override-cb" data-tid="${escapeHtml(tid)}" id="${overrideId}"> ` +
    `Override per finding</label>` +
    `</summary>` +
    `<div class="theme-member-findings">` +
    `${memberCards}` +
    `</div>` +
    `</details>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; font-size: 14px;
       background: #f4f5f7; color: #1a1a2e; line-height: 1.5; }
a { color: #4f46e5; }

/* Header */
.page-header { background: #1a1a2e; color: #fff; padding: 16px 24px;
               display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.page-header h1 { font-size: 20px; font-weight: 700; flex: 1; min-width: 200px; }
.header-stats { display: flex; gap: 16px; font-size: 13px; opacity: .85; }
.header-stat { display: flex; flex-direction: column; align-items: center; }
.header-stat strong { font-size: 22px; font-weight: 800; }
.reviewer-row { display: flex; align-items: center; gap: 10px; }
.reviewer-row label { font-size: 13px; opacity: .8; }
.reviewer-row input[type=text] { padding: 5px 10px; border-radius: 6px;
                                   border: none; font-size: 13px; width: 220px; }
.export-btn { padding: 8px 18px; background: #4f46e5; color: #fff; border: none;
              border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }
.export-btn:hover { background: #4338ca; }

/* Filters */
.filters-bar { background: #fff; padding: 10px 24px; display: flex; gap: 12px;
               align-items: center; border-bottom: 1px solid #e5e7eb; flex-wrap: wrap; }
.filters-bar label { font-size: 13px; font-weight: 500; }
.filters-bar select { padding: 5px 10px; border: 1px solid #d1d5db; border-radius: 6px;
                      font-size: 13px; background: #fff; }

/* Main layout */
main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
section { margin-bottom: 36px; }
section > h2 { font-size: 16px; font-weight: 700; color: #374151; margin-bottom: 14px;
               padding-bottom: 6px; border-bottom: 2px solid #e5e7eb; }

/* Unit screenshots */
.screenshots-strip { display: flex; gap: 8px; overflow-x: auto; margin-bottom: 12px;
                     padding-bottom: 4px; }
.screenshots-strip img { height: 120px; border-radius: 6px; border: 1px solid #e5e7eb;
                         object-fit: cover; cursor: zoom-in; }

/* Captured card shots */
.card-shot img { max-height: 220px; max-width: 100%; border-radius: 6px;
                 border: 1px solid #e5e7eb; cursor: zoom-in; margin: 6px 0 10px; }

/* Screenshot lightbox */
.lightbox { display: none; position: fixed; inset: 0; z-index: 100;
            background: rgba(15,23,42,.88); align-items: center;
            justify-content: center; cursor: zoom-out; }
.lightbox.open { display: flex; }
.lightbox img { max-width: 95vw; max-height: 95vh; border-radius: 8px;
                box-shadow: 0 8px 40px rgba(0,0,0,.5); }

/* Theme cards */
.theme-card { background: #fff; border-radius: 10px; padding: 16px;
              margin-bottom: 14px; border: 1px solid #e5e7eb;
              box-shadow: 0 1px 3px rgba(0,0,0,.05); }
.theme-header { display: flex; gap: 10px; align-items: baseline; margin-bottom: 10px; flex-wrap: wrap; }
.theme-id { font-family: monospace; font-size: 11px; color: #c4c8cf; margin-left: auto; }
.theme-title { font-weight: 700; font-size: 15px; }
.theme-members { margin: 8px 0 10px 16px; font-size: 13px; color: #4b5563; }
.theme-members li { margin-bottom: 3px; }
.member-id { font-size: 10px; color: #c4c8cf; }
.theme-details { margin-top: 10px; }
.theme-details summary { cursor: pointer; font-size: 13px; color: #6b7280; user-select: none; }
.override-label { font-size: 12px; cursor: pointer; }
.theme-member-findings { margin-top: 10px; }
.theme-member-card { border-left: 3px solid #c7d2fe; background: #fafafa; }

/* Finding cards */
.finding-card { background: #fff; border-radius: 10px; padding: 16px;
                margin-bottom: 12px; border: 1px solid #e5e7eb;
                box-shadow: 0 1px 3px rgba(0,0,0,.05); }
.finding-card[data-unit] { }
.finding-header { display: flex; gap: 8px; align-items: baseline; margin-bottom: 8px; flex-wrap: wrap; }
.finding-id { font-family: monospace; font-size: 11px; color: #c4c8cf; margin-left: auto; }
.finding-title { font-weight: 700; font-size: 15px; flex: 1; }
.unit-name { font-size: 12px; color: #9ca3af; }
.finding-intent { font-size: 13px; margin-bottom: 6px; color: #374151; }
.finding-state, .finding-spec { font-size: 13px; margin-bottom: 4px; }
.refs-summary { }
.refs { margin: 3px 0 3px 16px; }
.refs li { font-size: 12px; color: #6b7280; }
.reuse-line { font-size: 13px; margin: 6px 0; color: #4b5563; background: #f0fdf4;
              border-left: 3px solid #22c55e; padding: 4px 8px; border-radius: 0 4px 4px 0; }
.finding-summary { margin-top: 8px; font-size: 14px; }

/* Radio groups */
.radio-group { display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
.radio-group label { display: flex; align-items: center; gap: 5px; cursor: pointer;
                     font-size: 13px; font-weight: 500; }
.radio-accept { color: #15803d; }
.radio-decline { color: #dc2626; }
.radio-undecided { color: #6b7280; }

/* Override radios (hidden until override checkbox) */
.override-radios { display: none; }
.override-radios.active { display: flex; }

/* Badges */
.badge { display: inline-block; padding: 2px 8px; border-radius: 9999px;
         font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
.cat-visual { background: #dbeafe; color: #1d4ed8; }
.cat-behavioral { background: #fef3c7; color: #b45309; }
.cat-component-divergence { background: #ede9fe; color: #6d28d9; }
.cat-backend-gap { background: #fee2e2; color: #dc2626; }
.cat-token-drift { background: #d1fae5; color: #065f46; }
.intent-likely-intentional { background: #dcfce7; color: #15803d; }
.intent-likely-unintentional { background: #fef9c3; color: #854d0e; }
.intent-unclear { background: #fee2e2; color: #b91c1c; }

/* Hidden */
.hidden { display: none !important; }
`;

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

const JS = String.raw`
(function() {
  // Filters
  var unitSel = document.getElementById('filter-unit');
  var catSel  = document.getElementById('filter-cat');
  var intSel  = document.getElementById('filter-intent');

  function applyFilters() {
    var unit   = unitSel.value;
    var cat    = catSel.value;
    var intent = intSel.value;
    document.querySelectorAll('.finding-card:not(.theme-member-card)').forEach(function(card) {
      var show = (!unit   || card.dataset.unit   === unit)
              && (!cat    || card.dataset.category === cat)
              && (!intent || card.dataset.intent  === intent);
      card.classList.toggle('hidden', !show);
    });
  }
  unitSel.addEventListener('change', applyFilters);
  catSel.addEventListener('change', applyFilters);
  intSel.addEventListener('change', applyFilters);

  // Override checkboxes: show per-finding radios inside theme details
  document.querySelectorAll('.override-cb').forEach(function(cb) {
    cb.addEventListener('change', function() {
      var tid = cb.dataset.tid;
      var details = cb.closest('details');
      if (!details) return;
      details.querySelectorAll('.theme-member-card').forEach(function(card) {
        var rg = card.querySelector('.override-radios');
        if (rg) rg.classList.toggle('active', cb.checked);
      });
    });
  });

  // Export
  document.getElementById('export-btn').addEventListener('click', function() {
    var reviewer = document.getElementById('reviewer-input').value.trim() || 'unknown';
    var decisions = {};

    // Theme radios
    document.querySelectorAll('.theme-card').forEach(function(card) {
      var tid = card.dataset.tid;
      if (!tid) return;
      // thm- radio name is "thm-<slug>" where slug = tid without "thm-" prefix
      var radioName = tid.startsWith('thm-') ? ('thm-' + tid.slice(4)) : tid;
      var checked = card.querySelector('input[name="' + radioName + '"]:checked');
      if (checked && checked.value !== 'undecided') {
        decisions[tid] = { state: checked.value };
      }
    });

    // Finding radios (non-theme members, or overridden)
    document.querySelectorAll('.finding-card').forEach(function(card) {
      var fid = card.dataset.fid;
      if (!fid) return;
      var isThemeMember = card.classList.contains('theme-member-card');
      if (isThemeMember) {
        // Only export if override is active
        var rg = card.querySelector('.override-radios.active');
        if (!rg) return;
        var checked = rg.querySelector('input[type="radio"]:checked');
        if (checked && checked.value !== 'undecided') {
          decisions[fid] = { state: checked.value };
        }
        return;
      }
      var checked = card.querySelector('input[name="' + fid + '"]:checked');
      if (checked && checked.value !== 'undecided') {
        decisions[fid] = { state: checked.value };
      }
    });

    var doc = {
      schema_version: 1,
      reviewer: reviewer,
      decided_at: new Date().toISOString(),
      decisions: decisions
    };
    var blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'decisions.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  });

  // Screenshot lightbox: click a thumbnail to view full size, click or Escape to close.
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightbox-img');
  if (lightbox && lightboxImg) {
    document.querySelectorAll('.screenshots-strip img, .card-shot img').forEach(function(img) {
      img.addEventListener('click', function() {
        lightboxImg.src = img.src;
        lightbox.classList.add('open');
      });
    });
    lightbox.addEventListener('click', function() {
      lightbox.classList.remove('open');
      lightboxImg.src = '';
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && lightbox.classList.contains('open')) {
        lightbox.classList.remove('open');
        lightboxImg.src = '';
      }
    });
  }
})();
`;

// ---------------------------------------------------------------------------
// Main HTML builder
// ---------------------------------------------------------------------------

function buildHtml(
  docs: Array<[string, JsonObject]>,
  title: string,
  screenshotsDir: string | null,
): string {
  // Collect all units, themes, findings
  const allUnits: JsonObject[] = [];
  const allThemes: Array<[JsonObject, string]> = []; // [theme, unit_name]
  const themeToFindings: Map<string, JsonObject[]> = new Map();
  // standalone findings (theme == null), with unit_name
  const standaloneFindings: Array<[JsonObject, string]> = [];

  // Screenshots per unit: unit_id -> list of data-uris
  const unitScreenshots: Map<string, string[]> = new Map();
  let remainingBudget = MAX_SCREENSHOTS;

  for (const [, doc] of docs) {
    const unitRaw = doc["unit"];
    const unit: JsonObject =
      typeof unitRaw === "object" && unitRaw !== null && !Array.isArray(unitRaw)
        ? (unitRaw as JsonObject)
        : {};
    const unitId = String(unit["id"] ?? "");
    const unitName = String(unit["name"] ?? unitId);
    allUnits.push(unit);

    // Screenshots
    const refShots = Array.isArray(unit["reference_screenshots"])
      ? (unit["reference_screenshots"] as unknown[]).map(String)
      : [];
    if (refShots.length > 0 && remainingBudget > 0) {
      const uris = embedScreenshots(refShots, screenshotsDir, remainingBudget);
      if (uris.length > 0) {
        unitScreenshots.set(unitId, uris);
        remainingBudget -= uris.length;
      }
    }

    const themes = Array.isArray(doc["themes"]) ? (doc["themes"] as unknown[]) : [];
    for (const theme of themes) {
      if (typeof theme === "object" && theme !== null && !Array.isArray(theme)) {
        const themeObj = theme as JsonObject;
        allThemes.push([themeObj, unitName]);
        themeToFindings.set(String(themeObj["id"] ?? ""), []);
      }
    }

    const findings = Array.isArray(doc["findings"]) ? (doc["findings"] as unknown[]) : [];
    for (const finding of findings) {
      if (typeof finding !== "object" || finding === null || Array.isArray(finding)) continue;
      const findingObj = finding as JsonObject;
      const themeRef = findingObj["theme"];
      if (typeof themeRef === "string" && themeToFindings.has(themeRef)) {
        themeToFindings.get(themeRef)!.push(findingObj);
      } else {
        standaloneFindings.push([findingObj, unitName]);
      }
    }
  }

  // Sort standalone findings by intent priority
  standaloneFindings.sort(([a], [b]) => intentRank(a) - intentRank(b));

  // Counts
  const totalUnits = allUnits.length;
  const totalFindings = docs.reduce((sum, [, doc]) => {
    return sum + (Array.isArray(doc["findings"]) ? (doc["findings"] as unknown[]).length : 0);
  }, 0);
  const decisionsNeeded = docs.reduce((sum, [, doc]) => {
    const findings = Array.isArray(doc["findings"]) ? (doc["findings"] as unknown[]) : [];
    return (
      sum +
      findings.filter((f) => {
        if (typeof f !== "object" || f === null || Array.isArray(f)) return false;
        const fObj = f as JsonObject;
        const decision = fObj["decision"];
        if (typeof decision !== "object" || decision === null || Array.isArray(decision)) return false;
        return (decision as JsonObject)["state"] === "pending";
      }).length
    );
  }, 0);

  // Build filter options
  const unitOptions =
    '<option value="">All units</option>' +
    allUnits
      .map(
        (u) =>
          `<option value="${escapeHtml(String(u["id"] ?? ""))}">${escapeHtml(String(u["name"] ?? u["id"] ?? ""))}</option>`,
      )
      .join("");
  const catOptions =
    '<option value="">All categories</option>' +
    FINDING_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  const intentOptions =
    '<option value="">All intents</option>' +
    INTENTS.map((i) => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join("");

  // Build themes section HTML
  const themesHtmlParts: string[] = [];
  for (const [theme, unitName] of allThemes) {
    const tid = String(theme["id"] ?? "");
    const members = themeToFindings.get(tid) ?? [];
    themesHtmlParts.push(themeCardHtml(theme, unitName, members));
  }

  // Build findings section HTML (standalone, i.e. theme == null)
  const findingsHtmlParts: string[] = [];
  for (const [finding, unitName] of standaloneFindings) {
    findingsHtmlParts.push(findingCardHtml(finding, unitName, true));
  }

  const themesSection = themesHtmlParts.join("\n") || "<p>No themes.</p>";
  const findingsSection = findingsHtmlParts.join("\n") || "<p>No standalone findings.</p>";

  // Build unit screenshots strips for section headers
  let screenshotsStripHtml = "";
  for (const unit of allUnits) {
    const uid = String(unit["id"] ?? "");
    const uris = unitScreenshots.get(uid);
    if (uris && uris.length > 0) {
      const imgs = uris.map((uri) => `<img src="${uri}" alt="screenshot">`).join("");
      screenshotsStripHtml += `<div class="unit-screenshots" data-unit="${escapeHtml(uid)}"><div class="screenshots-strip">${imgs}</div></div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<header class="page-header">
  <h1>${escapeHtml(title)}</h1>
  <div class="header-stats">
    <div class="header-stat"><strong>${totalUnits}</strong><span>Units</span></div>
    <div class="header-stat"><strong>${totalFindings}</strong><span>Findings</span></div>
    <div class="header-stat"><strong>${decisionsNeeded}</strong><span>Decisions needed</span></div>
  </div>
  <div class="reviewer-row">
    <label for="reviewer-input">Reviewer:</label>
    <input type="text" id="reviewer-input" placeholder="your name or email">
  </div>
  <button class="export-btn" id="export-btn">Export decisions.json</button>
</header>

<div class="filters-bar">
  <label for="filter-unit">Unit:</label>
  <select id="filter-unit">${unitOptions}</select>
  <label for="filter-cat">Category:</label>
  <select id="filter-cat">${catOptions}</select>
  <label for="filter-intent">Intent:</label>
  <select id="filter-intent">${intentOptions}</select>
</div>

<main>
${screenshotsStripHtml}

<section id="themes-section">
  <h2>Themes</h2>
  ${themesSection}
</section>

<section id="findings-section">
  <h2>Findings</h2>
  ${findingsSection}
</section>
</main>

<div class="lightbox" id="lightbox"><img id="lightbox-img" alt="screenshot enlarged"></div>

<script>
${JS}
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      findings: { type: "string", multiple: true },
      out: { type: "string" },
      "screenshots-dir": { type: "string" },
      title: { type: "string", default: "Design Inventory Review" },
    },
  });

  const findingsPaths = values.findings;
  if (!findingsPaths || findingsPaths.length === 0) {
    console.error("error: --findings is required");
    return 1;
  }
  const outPath = values.out;
  if (!outPath) {
    console.error("error: --out is required");
    return 1;
  }

  const docs = loadFindingsFiles(findingsPaths);
  if (docs === null || docs.length === 0) {
    // loadFindingsFiles already printed errors for null; empty means no usable docs
    if (docs !== null) {
      console.error("error: no findings documents found");
    }
    return 1;
  }

  // Validate all documents
  let anyErrors = false;
  for (const [path, doc] of docs) {
    const errors = validateFindings(doc);
    if (errors.length > 0) {
      console.error(`error: ${path} has validation errors:`);
      for (const e of errors) {
        console.error(`  - ${e}`);
      }
      anyErrors = true;
    }
  }
  if (anyErrors) return 1;

  const screenshotsDir = values["screenshots-dir"] ?? null;
  const html = buildHtml(docs, String(values.title ?? "Design Inventory Review"), screenshotsDir);

  try {
    writeFileSync(outPath, html, "utf-8");
  } catch (exc) {
    console.error(`error: cannot write ${outPath}: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }

  console.log(outPath);
  return 0;
}

runWhenMain(import.meta.url, main);
