import assert from "node:assert/strict";
import test from "node:test";

import { needsInput, rankChoices } from "../dist/needs.js";

test("a single missing argument becomes one question with instructions to ask", () => {
  const r = needsInput("cs_add_tool", [
    { argument: "connectorId", question: "Which connector should this tool use?", why: "It decides what the tool can do.", choices: [{ value: "shared_office365", label: "Office 365 Outlook" }], moreWith: "cs_list_connectors" },
  ]);
  assert.equal(r.needsInput, true);
  assert.equal(r.tool, "cs_add_tool");
  assert.equal(r.needs.length, 1);
  assert.match(r.next, /Ask the user: Which connector should this tool use\?/);
  assert.match(r.next, /Offer the choices listed here rather than inventing values/);
  assert.match(r.next, /cs_list_connectors lists more/);
  assert.match(r.next, /call cs_add_tool again with 'connectorId'/);
});

test("long choice lists are shortened, and the total says how many there were", () => {
  const many = Array.from({ length: 90 }, (_, i) => ({ value: `shared_c${i}` }));
  const r = needsInput("cs_add_tool", [{ argument: "connectorId", question: "Which one?", choices: many }]);
  assert.equal(r.needs[0].choices.length, 25);
  assert.equal(r.needs[0].totalChoices, 90);
  assert.equal(r.needs[0].choices[0].value, "shared_c0", "the best-ranked choices are kept");

  const few = needsInput("t", [{ argument: "a", question: "q", choices: [{ value: "x" }] }]);
  assert.equal(few.needs[0].totalChoices, undefined, "no total when nothing was cut");
});

test("several missing arguments produce one instruction covering them", () => {
  const r = needsInput("cs_add_knowledge_source", [
    { argument: "kind", question: "Which kind of knowledge?" },
    { argument: "site", question: "Which URL?" },
  ]);
  assert.equal(r.needs.length, 2);
  assert.match(r.next, /Ask the user the questions listed here/);
  assert.match(r.next, /call cs_add_knowledge_source again/);
});

test("a caller-supplied instruction wins", () => {
  const r = needsInput("cs_clone_agent", [{ argument: "bot", question: "Which agent?" }], "Sign in first, then ask which agent.");
  assert.equal(r.next, "Sign in first, then ask which agent.");
});

test("rankChoices puts exact, prefix and substring matches first and drops the rest", () => {
  const items = ["shared_sharepointonline", "shared_office365", "Office 365 Outlook", "shared_teams", "sharepoint document library"];
  // "Office 365 Outlook" starts with the search, so it outranks a name that merely contains it.
  assert.deepEqual(rankChoices(items, "office", (s) => s), ["Office 365 Outlook", "shared_office365"]);
  assert.deepEqual(rankChoices(items, "shared_teams", (s) => s), ["shared_teams"], "an exact match comes first");
  assert.deepEqual(rankChoices(items, "sharepoint document", (s) => s), ["sharepoint document library"]);
  assert.deepEqual(rankChoices(items, "nothing here", (s) => s), [], "no match means no choices, rather than a misleading list");
  assert.equal(rankChoices(items, undefined, (s) => s).length, items.length, "without a search everything is offered");
  assert.equal(rankChoices(items, "   ", (s) => s).length, items.length);
});

test("ranking works on objects through the text accessor, keeping input order within a rank", () => {
  const conns = [
    { value: "shared_teams", label: "Microsoft Teams" },
    { value: "shared_office365", label: "Office 365 Outlook" },
    { value: "shared_office365users", label: "Office 365 Users" },
  ];
  const ranked = rankChoices(conns, "office 365", (c) => `${c.label} ${c.value}`);
  assert.deepEqual(ranked.map((c) => c.value), ["shared_office365", "shared_office365users"]);
});
