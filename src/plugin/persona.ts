import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EngramConfig } from "../config.js";

const USER_SECTION_MARKER = "<!-- USER -->";
const AGENT_SECTION_MARKER = "<!-- AGENT-SUGGESTED -->";

export function readPersona(config: EngramConfig): string {
  if (!existsSync(config.personaPath)) {
    return "";
  }
  return readFileSync(config.personaPath, "utf8").trim();
}

export function writePersona(config: EngramConfig, content: string): string {
  mkdirSync(dirname(config.personaPath), { recursive: true });
  const normalized = content.trim();
  writeFileSync(config.personaPath, `${normalized}${normalized ? "\n" : ""}`, "utf8");
  return normalized;
}

export function appendUserFact(config: EngramConfig, fact: string): string {
  const normalizedFact = fact.trim();
  const sections = parsePersonaSections(readPersona(config));
  if (normalizedFact && !sections.user.includes(`- ${normalizedFact}`)) {
    sections.user.push(`- ${normalizedFact}`);
  }
  const rendered = renderPersonaSections(sections);
  writePersona(config, rendered);
  return rendered;
}

export function mergePendingFacts(config: EngramConfig, approvedIds: string[]): string {
  const uniqueIds = [...new Set(approvedIds.map((value) => value.trim()).filter(Boolean))];
  const sections = parsePersonaSections(readPersona(config));
  if (!existsSync(config.dbPath) || uniqueIds.length === 0) {
    const rendered = renderPersonaSections(sections);
    writePersona(config, rendered);
    return rendered;
  }

  const db = new DatabaseSync(config.dbPath, { open: true, readOnly: true });
  try {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT fact_id AS factId, content
      FROM kb_facts
      WHERE fact_id IN (${placeholders})
        AND approval_state = 'approved'
        AND memory_class = 'identity'
    `).all(...uniqueIds) as Array<{ factId: string; content: string }>;

    for (const row of rows) {
      const line = `- [${row.factId}] ${row.content.trim()}`;
      if (!sections.agentSuggested.includes(line)) {
        sections.agentSuggested.push(line);
      }
    }
  } finally {
    db.close();
  }

  const rendered = renderPersonaSections(sections);
  writePersona(config, rendered);
  return rendered;
}

export function formatPersonaBlock(content: string): string {
  if (!content.trim()) {
    return "";
  }
  return [
    `<engram_persona source="${escapeXml("persona.md")}">`,
    content
      .split(/\r?\n/)
      .map((line) => `  ${escapeXml(line)}`)
      .join("\n"),
    `</engram_persona>`,
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type ParsedPersonaSections = {
  preamble: string[];
  user: string[];
  agentSuggested: string[];
};

function parsePersonaSections(content: string): ParsedPersonaSections {
  const sections: ParsedPersonaSections = {
    preamble: [],
    user: [],
    agentSuggested: [],
  };
  let current: keyof ParsedPersonaSections = "preamble";

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const marker = line.trim();
    if (marker === USER_SECTION_MARKER) {
      current = "user";
      continue;
    }
    if (marker === AGENT_SECTION_MARKER) {
      current = "agentSuggested";
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    sections[current].push(line);
  }

  return sections;
}

function renderPersonaSections(sections: ParsedPersonaSections): string {
  const content = [
    ...sections.preamble,
    USER_SECTION_MARKER,
    ...sections.user,
    AGENT_SECTION_MARKER,
    ...sections.agentSuggested,
  ].filter(Boolean);
  return content.join("\n").trim();
}