# Context

The domain language for this project. A glossary, not a spec — no implementation detail belongs here.

## Tenant

One Slack workspace and everything the coworker holds or runs for it: its Threads, Vault,
Skills, configuration, credentials, Sessions, Jobs, and Schedules. Every domain operation
belongs to an explicit Tenant. A self-hosted instance has exactly one Tenant; hosted
composition may serve many, without sharing their state.

## Thread

A Slack conversation thread. The unit of **topic** and the unit of **audience**: everyone who can see the channel can see the thread, and nothing crosses between threads except through the [Vault](#vault).

Where the word is ambiguous — Codex also calls its own conversations "threads" — this glossary always means the Slack one. The Codex side is a [Session](#session).

## Session

The coworker's accumulated understanding of one Thread. Exactly one Session per Thread, for the life of the Thread: a follow-up three days later resumes the same Session and remembers what was said.

Sessions are isolated from one another. A Session knows what happened in its own Thread and what the coworker has written to the Vault — nothing else. This is deliberate: it makes the coworker's knowledge explainable ("it knows what it wrote down") and keeps a private channel's contents out of a public channel's answers.

One kind of work belongs to no Session: the [Librarian](#librarian)'s closing pass. It is a **one-off call** — a conversation nobody resumes, handed what it needs to know and then forgotten. It is not the Thread's Session and does not become part of it, which is why it has to be *told* what happened in the Job rather than remembering it.

## Job

One piece of delegated work: a human mentions the coworker, the coworker works, the coworker reports back. A Job is the unit a human thinks in — "I asked it to do a thing" — and the unit that succeeds or fails as a whole.

A Job belongs to exactly one Thread and runs in that Thread's Session. Jobs in the same Thread are strictly sequential; a mention arriving while a Job runs is queued for the next one.

## Schedule

A standing delegation that asks the coworker to perform a natural-language task at a
specified time, either once or on a recurring calendar cadence. A Schedule names the Slack
channel where its Jobs are reported; it is not a shell command or an event subscription.

## Occurrence

One time at which a [Schedule](#schedule) becomes due. An Occurrence creates an ordinary
[Job](#job), with the same powers and limits as work delegated directly in Slack; an
Occurrence missed while the coworker is offline is skipped.

## Turn

The unit of **durability**, imposed by the engine rather than chosen. Work is preserved at Turn boundaries: a Turn that completes is durable and resumable, a Turn interrupted partway cannot be resumed and its side effects may have partially landed.

A Job is normally one Turn. The distinction matters only at failure, which is exactly when it matters most.

## Vault

The linked web of Markdown files the coworker reads, and which a human may open in Obsidian and edit directly. The only channel by which anything crosses between Sessions, and **the coworker's only memory** — there is no separate memory store.

Wikilinks are structure, not decoration: the Vault is a graph the coworker traverses, not a folder it scans.

It has **two halves, divided by who may write them**: its [Notes](#note), which the coworker writes, and its [Skills](#skill), which only a human writes. Both are Markdown, both are in the same Obsidian vault, and a wikilink crosses freely between them — the division is authorship, not subject matter.

## Note

A single Markdown file in the Vault. The one kind of artifact the coworker writes — what a human would call a note and what the coworker uses as memory are the same object, in the same place, in the same format. Either party may edit any Note.

A Note is **the current belief about its topic**, not a log of beliefs. Learning something that contradicts a Note means rewriting that Note, so divergence becomes visible to a human reading the Vault rather than accumulating silently.

Frontmatter carries when it was last modified and which Thread and Job wrote it, so both a human and the coworker can judge staleness and origin. When a Job used files shared in its Slack Thread, their filenames are stamped conservatively as source files too. It is stamped by the wrapper rather than written by the coworker: the one field that says "this came from the coworker" should not be the one field the coworker could forget.

## Root note

The Vault's entry point: hub links only — people, projects, recurring topics — with every real fact one hop away in the graph. Small by construction and present in every Job, so the coworker always knows the map exists and where its doors are.

Its grammar is **wikilinks and short labels, nothing else** — it is the one file that is prompt rather than data, so it must have no room for prose that could instruct a future Job. Why a hub matters belongs in the hub's own Note.

It is an ordinary Note otherwise. A human can open it and rewrite it.

## Librarian

The coworker's standing responsibility for the Vault's navigability, discharged at the end of each Job: judge whether anything durable was learned, and if so file the Note where it belongs, wire its wikilinks, and update the Root note if a new hub appeared. Deliberately separate from doing the work, because curation degrades when it competes with the task for attention.

**Writing nothing is a normal outcome.** Most Jobs answer a question and leave no trace in the Vault; only what is worth remembering becomes a Note. The judgment is the Librarian's, not a rule.

The Librarian may not write a [Skill](#skill) — those are human-authored.

## Skill

A procedure a human wrote down for the coworker to follow: how to reach a system, which command to run, how to read the result. A Markdown file like any Note, in the same Vault, edited in the same Obsidian.

Two things separate a Skill from a Note. A Note is *belief*; a Skill is *instruction* — it directs behaviour rather than describing the world. And a Skill is **human-authored only**: the coworker reads and follows it but cannot write one, because a Skill it could edit would be a way for one Job to run commands in another Job's Thread.

A Skill names an environment variable where a credential is needed; it never contains one.

**A Skill is one of the two ways the coworker reaches an outside system**, the other being
an MCP server named in the instance's `mcp.json`. GitHub and Linear are MCP servers. Skills
cover procedures for systems without a suitable server, such as a read-only reporting
database. A Skill puts its action boundary entirely in the credential because nothing
mediates the shell; an MCP server also permits exact tools to be disabled.

## Progress

What a Job says about itself while it is still running: the coworker's own plan, and which step of it the work has reached. One thing per Job, **revised** rather than added to — the person who delegated the work walked away, and what they want on returning is one glance, not a transcript of the working.

The counterpart to a [Write](#write), and deliberately its opposite in every respect. Progress is provisional and gets overwritten; a Write is final and never does. Confusing the two loses the audit record, which is why they are separate words.

## Vault change

A creation, edit, or deletion inside the Vault's Notes. It is durable memory bookkeeping,
not part of the human conversation: its full diff belongs in the server's Vault log rather
than in the Thread.

## Write

An action the coworker takes against an external system or the Thread itself: opening a
pull request, updating a ticket, posting a comment, or sharing a result file. Distinguished
from reading because the coworker acts unattended. Shell actions the wrapper can identify
are appended to the Thread as permanent records.

**The Job's workspace is part of "itself".** A scratch script the coworker writes to answer
a question changed nothing anyone else owns, and reporting it would be narration. A
[Vault change](#vault-change) has its own operational record and is not a conversational
Write.

**MCP calls and result-file delivery do not create separate receipt messages.** Connector
activity belongs in the Job's final answer when it matters, and the uploaded file is its own
visible Slack message. Posting a receipt for every connector read or file upload makes the
conversation harder to follow without adding a useful outcome.

Shell Write receipts are never revised once recorded and never carried by
[Progress](#progress).
