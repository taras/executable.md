/**
 * Tier NA — native answer observation
 * (specs/native-agent-session-launch-spec.md §Provider-returned adapters).
 *
 * The Codex native proof has to decide whether the agent answered, and the only
 * thing it can read is a pseudo-terminal. A TUI draws by moving the cursor and
 * repainting, so the bytes it emitted and the screen it is showing are two
 * different things — which means a proof that searches the byte stream can find
 * text that has since been erased, or text the program printed before it took
 * the screen, while missing an answer the screen is showing right now.
 *
 * These cases drive fake TUI streams through the reconstruction the proof uses
 * and check both halves: that a real answer is read however it was drawn, and
 * that everything an answer is not is refused. No Codex process starts and no
 * model turn is spent — the streams here are written by hand, so what the
 * observer does with each shape is decided rather than sampled.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  observeAnswer,
  screenShows,
  terminalChannels,
  TerminalReader,
  terminalReader,
  TerminalScreen,
} from "./fixtures/terminal-screen.ts";
import type { AnswerQuestion } from "./fixtures/terminal-screen.ts";

/** The pty the proof opens, so these streams wrap where that one wraps. */
const ROWS = 40;
const COLUMNS = 120;

const ESC = String.fromCharCode(0x1b);
const csi = (body: string): string => `${ESC}[${body}`;
/** Cursor position, one-based as a terminal counts. */
const at = (row: number, column: number): string => csi(`${row};${column}H`);
/** The TUI takes the screen, and gives the shell's back when it leaves. */
const ALT_ON = csi("?1049h");
const ALT_OFF = csi("?1049l");
const CLEAR = csi("2J");
/** Hold the drawing back, and put the finished frame on show. */
const SYNC_ON = csi("?2026h");
const SYNC_OFF = csi("?2026l");

/** Repaint the whole screen by addressing each row, as a TUI does. */
function paint(rows: readonly string[]): string {
  return rows.map((row, index) => `${at(index + 1, 1)}${csi("2K")}${row}`).join("");
}

/** A bordered pane row, padded to its right border as a TUI pads one. */
function pane(text: string, width = 60): string {
  return `│ ${text.padEnd(width)} │`;
}

function border(width = 60, left = "╭", right = "╮"): string {
  return `${left}${"─".repeat(width + 2)}${right}`;
}

/**
 * The sentence the native proof asks for. Chosen there because it is the first
 * sentence of the instruction layer the launch installed, so it is text only a
 * governed turn produces.
 */
const ANSWER = "The Implementor delivers an accepted plan as a focused, verified change.";

/** A turn shaped like the proof's, which does not contain its own answer. */
const TYPED =
  "Do not use any tools. Reply with exactly two lines. First line: " +
  "the first sentence of the body text under the 'Implementor' heading.";

/** Codex's own furniture, named the same way the proof names it. */
const CHROME: readonly string[] = ["Ask Codex to do anything", "esc to interrupt"];

function screen(): TerminalScreen {
  return new TerminalScreen({ rows: ROWS, columns: COLUMNS });
}

function asked(over: Partial<AnswerQuestion> = {}): AnswerQuestion {
  return { expected: ANSWER, typed: TYPED, chrome: CHROME, ...over };
}

describe("Tier NA — native answer observation", () => {
  it("NA1: text printed before the TUI took the screen is not an answer", function* () {
    const terminal = screen();
    terminal.write(`${ANSWER}\r\n`);

    // On the shell's own screen the words are genuinely there, which is why a
    // proof reading retained bytes would have accepted them.
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);

    terminal.write(ALT_ON);

    const observed = observeAnswer(terminal.snapshot(), asked());
    expect(terminal.snapshot().alternate).toBe(true);
    expect(observed).toEqual({ found: false, reason: "absent" });
  });

  it("NA2: an answer the terminal wrapped mid-word is read as one sentence", function* () {
    const terminal = screen();
    // Started 21 columns from the right margin, so the terminal itself breaks
    // the word `delivers` across two rows with no space where it broke.
    terminal.write(`${ALT_ON}${at(5, COLUMNS - 20)}${ANSWER}`);

    const rows = terminal.snapshot().rows;
    expect(rows[4]?.endsWith("The Implementor deliv")).toBe(true);
    expect(rows[5]).toBe("ers an accepted plan as a focused, verified change.");
    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: true,
      reason: "answer",
    });
  });

  it("NA3: an answer a repaint moved is read from where it now is", function* () {
    const terminal = screen();
    terminal.write(`${ALT_ON}${paint(["", "", ANSWER])}`);
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);

    terminal.write(`${CLEAR}${paint([...Array.from({ length: 19 }, () => ""), ANSWER])}`);

    expect(terminal.snapshot().rows[2]).toBe("");
    expect(terminal.snapshot().rows[19]).toBe(ANSWER);
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);
  });

  it("NA4: a repaint that replaces the answer is refused, though the bytes remain", function* () {
    const terminal = screen();
    terminal.write(`${ALT_ON}${paint(["", "", ANSWER])}`);
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);

    terminal.write(paint(["", "", "Working on it."]));

    // The stream still carries every byte of the answer; the screen does not,
    // and the screen is what an operator would be looking at.
    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });
  });

  it("NA5: an answer wrapped inside a bordered pane is read across the border", function* () {
    const terminal = screen();
    terminal.write(
      `${ALT_ON}${paint([
        border(),
        pane("The Implementor delivers an accepted plan as a"),
        pane("focused, verified change."),
        border(60, "╰", "╯"),
      ])}`,
    );

    expect(terminal.snapshot().rows[1]?.startsWith("│ The Implementor")).toBe(true);
    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: true,
      reason: "answer",
    });
  });

  it("NA6: cells an erase blanked do not close up into an answer", function* () {
    const terminal = screen();
    terminal.write(`${ALT_ON}${at(5, 1)}${ANSWER}`);
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);

    // Twenty cells out of the middle of the sentence, which is what a redraw
    // that has not finished repainting leaves behind.
    terminal.write(`${at(5, 25)}${csi("20X")}`);

    expect(terminal.snapshot().rows[4]).toBe(
      `The Implementor delivers${" ".repeat(21)}a focused, verified change.`,
    );
    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });
  });

  it("NA7: a gap inside a row is a gap, not a join", function* () {
    const terminal = screen();
    // Two columns that would read as the sentence if the blank cells between
    // them closed up — which is what erasing part of a row, or laying two panes
    // side by side, leaves on the screen.
    terminal.write(
      `${ALT_ON}${at(5, 1)}The Implementor delivers an accepted plan` +
        `${at(5, 60)}as a focused, verified change.`,
    );

    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });
  });

  it("NA8: two panes on one row are two pieces of text", function* () {
    const terminal = screen();
    // Borders with no padding either side, so nothing but the border itself
    // says where one pane's text stops and the next one's starts.
    terminal.write(
      `${ALT_ON}${at(5, 1)}` +
        "│The Implementor delivers an accepted plan│as a focused, verified change.│",
    );

    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });
  });

  it("NA9: the harness reading its own turn back is not an answer", function* () {
    const terminal = screen();
    const quoting = `Reply with exactly this: ${ANSWER}`;
    terminal.write(`${ALT_ON}${paint(["", quoting])}`);

    expect(observeAnswer(terminal.snapshot(), asked({ typed: quoting }))).toEqual({
      found: false,
      reason: "only-typed",
    });

    // And the echo does not go on refusing once the agent has actually replied.
    terminal.write(paint(["", quoting, "", ANSWER]));
    expect(observeAnswer(terminal.snapshot(), asked({ typed: quoting }))).toEqual({
      found: true,
      reason: "answer",
    });
  });

  it("NA10: an answer still being drawn is not an answer yet", function* () {
    const terminal = screen();
    terminal.write(`${ALT_ON}${at(5, 1)}The Implementor delivers an accepted plan as a foc`);

    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });

    terminal.write("used, verified change.");
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);
  });

  it("NA11: text the TUI drew as its own furniture is not an answer", function* () {
    const onOneRow = screen();
    onOneRow.write(`${ALT_ON}${at(38, 1)}Ask Codex to do anything · ${ANSWER}`);
    expect(observeAnswer(onOneRow.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });

    const across = screen();
    across.write(
      `${ALT_ON}${paint([
        "The Implementor delivers an accepted plan as a",
        "Ask Codex to do anything",
        "focused, verified change.",
      ])}`,
    );
    expect(observeAnswer(across.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });
  });

  it("NA12: an idle composer is the terminal's state, not the absence of an answer", function* () {
    const terminal = screen();
    terminal.write(
      `${ALT_ON}${paint([
        "› Do not use any tools.",
        "",
        ANSWER,
        "",
        border(),
        pane("Ask Codex to do anything"),
        border(60, "╰", "╯"),
      ])}`,
    );

    const snapshot = terminal.snapshot();
    expect(screenShows(snapshot, "Ask Codex to do anything")).toBe(true);
    expect(observeAnswer(snapshot, asked())).toEqual({ found: true, reason: "answer" });
  });

  it("NA13: an answer that scrolled off the screen is gone with it", function* () {
    const terminal = screen();
    terminal.write(`${ALT_ON}${at(ROWS, 1)}${ANSWER}`);
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);

    terminal.write("\r\n".repeat(ROWS));

    expect(observeAnswer(terminal.snapshot(), asked())).toEqual({
      found: false,
      reason: "absent",
    });
  });

  it("NA14: a control sequence split across two reads is still one sequence", function* () {
    const terminal = screen();
    for (const chunk of [`${ESC}[?10`, "49h", `${ESC}[5`, `;1H${ANSWER}`]) {
      terminal.write(chunk);
    }

    const snapshot = terminal.snapshot();
    expect(snapshot.alternate).toBe(true);
    expect(snapshot.rows[4]).toBe(ANSWER);
    expect(snapshot.rows.some((row) => row.includes("49h") || row.includes(";1H"))).toBe(false);
    expect(observeAnswer(snapshot, asked()).found).toBe(true);
  });

  it("NA15: leaving the alternate screen gives back what the shell had", function* () {
    const terminal = screen();
    terminal.write("checking codex\r\n");
    terminal.write(`${ALT_ON}${paint(["", "", ANSWER])}`);
    expect(observeAnswer(terminal.snapshot(), asked()).found).toBe(true);

    terminal.write(ALT_OFF);

    const snapshot = terminal.snapshot();
    expect(snapshot.alternate).toBe(false);
    expect(snapshot.rows[0]).toBe("checking codex");
    expect(observeAnswer(snapshot, asked())).toEqual({ found: false, reason: "absent" });
  });

  it("NA16: bytes arriving one at a time reconstruct the same screen", function* () {
    const whole = screen();
    const stream = `${ALT_ON}${paint([
      border(),
      pane(ANSWER.slice(0, 45)),
      pane(ANSWER.slice(45).trim()),
    ])}`;
    whole.write(stream);

    const dribbled = screen();
    for (const char of stream) {
      dribbled.write(char);
    }

    expect(dribbled.snapshot()).toEqual(whole.snapshot());
    expect(observeAnswer(dribbled.snapshot(), asked()).found).toBe(true);
  });

  it("NA17: a pane border split down the middle of its bytes is still one border", function* () {
    // What the proof actually hands over: a pty delivers bytes, and a pane
    // border is three of them per glyph. A read that ends inside one would
    // otherwise put a replacement character on the screen where the border
    // goes, and the run boundaries are drawn from those borders.
    const stream = `${ALT_ON}${paint([
      border(),
      pane(ANSWER.slice(0, 45)),
      pane(ANSWER.slice(45).trim()),
    ])}`;
    const bytes = new TextEncoder().encode(stream);

    const whole = screen();
    whole.write(bytes);

    const split = screen();
    for (let index = 0; index < bytes.length; index += 1) {
      split.write(bytes.subarray(index, index + 1));
    }

    expect(split.snapshot()).toEqual(whole.snapshot());
    expect(split.snapshot().rows.join("")).not.toContain("�");
    expect(observeAnswer(split.snapshot(), asked()).found).toBe(true);
  });

  it("NA18: clearing the scrollback leaves the answer on the screen", function* () {
    const drawn = (): TerminalScreen => {
      const terminal = screen();
      terminal.write(`${ALT_ON}${paint(["", "", ANSWER])}`);
      return terminal;
    };

    // `3J` is the scrollback, which is above the screen rather than on it, and
    // an unimplemented parameter is not an instruction to blank anything. Both
    // are here because either one falling through to a whole-screen erase would
    // make this observer report the answer it is looking at as absent.
    const scrollback = drawn();
    scrollback.write(csi("3J"));
    expect(scrollback.snapshot().rows[2]).toBe(ANSWER);
    expect(observeAnswer(scrollback.snapshot(), asked()).found).toBe(true);

    const unknown = drawn();
    unknown.write(csi("9J"));
    expect(observeAnswer(unknown.snapshot(), asked()).found).toBe(true);

    // And the mode that does mean the visible screen still means it.
    const visible = drawn();
    visible.write(csi("2J"));
    expect(visible.snapshot().rows.join("")).toBe("");
    expect(observeAnswer(visible.snapshot(), asked()).found).toBe(false);
  });

  it("NA19: the watch latches on the read that finishes the answer", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    expect(watch.write(`${ALT_ON}${paint([pane("Ask Codex to do anything")])}`)).toBe(false);
    expect(watch.ask(asked())).toBe(false);

    // Read by read, as the pty hands them over: the answer is not answered
    // until the read that puts the last of it on the screen.
    expect(watch.write(paint(["", "", "The Implementor delivers an accepted"]))).toBe(false);
    expect(watch.write(paint(["", "", ANSWER]))).toBe(true);
    expect(watch.found).toBe(true);
  });

  it("NA20: a redraw over the answer does not un-answer the turn", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());
    expect(watch.write(paint(["", "", ANSWER]))).toBe(true);

    watch.write(`${CLEAR}${paint(["", "", "", "", border(), pane("Ask Codex to do anything")])}`);

    // The screen has moved on, and the screen is right about what it is
    // showing — but the question was whether the agent answered, and a TUI
    // repainting over its own reply is not the agent taking it back.
    expect(observeAnswer(watch.snapshot(), asked()).found).toBe(false);
    expect(watch.found).toBe(true);
    expect(watch.write("")).toBe(true);
  });

  it("NA21: an occurrence from before the turn does not latch", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    // The words are genuinely on the shell's screen here, which is exactly why
    // a watch armed from the start of the process would have latched on them.
    watch.write(`${ANSWER}\r\n`);
    watch.write(`${ALT_ON}${paint([pane("Ask Codex to do anything")])}`);

    expect(watch.ask(asked())).toBe(false);
    expect(watch.write(paint([pane("esc to interrupt")]))).toBe(false);
    expect(watch.found).toBe(false);
  });

  it("NA22: the turn echoing back in the composer does not latch", function* () {
    const quoting = `Reply with exactly this: ${ANSWER}`;
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked({ typed: quoting }));

    expect(watch.write(paint(["", `› ${quoting}`]))).toBe(false);
    expect(watch.found).toBe(false);

    expect(watch.write(paint(["", `› ${quoting}`, "", ANSWER]))).toBe(true);
  });

  it("NA23: an answer still being drawn does not latch until it is whole", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(`${ALT_ON}${at(5, 1)}`);
    watch.ask(asked());

    expect(watch.write("The Implementor delivers an accepted plan as a foc")).toBe(false);
    expect(watch.write("used, verified change.")).toBe(true);
  });

  it("NA24: an answer erased within the read that drew it was never on the screen", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());

    const chunk = `${at(5, 1)}${ANSWER}${at(5, 25)}${csi("20X")}`;
    expect(chunk).toContain(ANSWER);
    expect(watch.write(chunk)).toBe(false);

    // Every byte of the answer went through the watch, and no read boundary
    // ever exposed it — which is the whole difference between reading the
    // stream and reading the terminal.
    expect(watch.found).toBe(false);
  });

  it("NA25: the TUI's own furniture does not latch", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());

    for (const line of CHROME) {
      expect(watch.write(paint(["", line]))).toBe(false);
    }
    expect(watch.found).toBe(false);

    expect(watch.write(paint(["", CHROME[0] ?? "", "", ANSWER]))).toBe(true);
  });

  it("NA26: the watch latches an answer whose glyphs were split across reads", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    const bytes = new TextEncoder().encode(
      `${ALT_ON}${paint([
        border(),
        pane(ANSWER.slice(0, 45)),
        pane(ANSWER.slice(45).trim()),
        border(60, "╰", "╯"),
      ])}`,
    );
    watch.ask(asked());

    let latched = false;
    for (let index = 0; index < bytes.length; index += 1) {
      latched = watch.write(bytes.subarray(index, index + 1));
    }

    expect(latched).toBe(true);
    expect(watch.snapshot().rows.join("")).not.toContain("�");
  });

  it("NA27: a frame that erased the answer before showing it does not latch", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());

    // What a repaint of a scrolling transcript looks like from inside: the
    // sentence is laid down and taken away again while the terminal is holding
    // its output back, so nobody watching the pty was ever shown it.
    expect(watch.write(`${SYNC_ON}${paint(["", "", ANSWER])}`)).toBe(false);
    expect(watch.write(paint(["", "", "Working on it."]))).toBe(false);
    expect(watch.write(SYNC_OFF)).toBe(false);
    expect(watch.found).toBe(false);
  });

  it("NA28: an answer the committed frame is showing latches at the commit", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());

    expect(watch.write(`${SYNC_ON}${paint(["", "", ANSWER])}`)).toBe(false);
    expect(watch.write(SYNC_OFF)).toBe(true);
    expect(watch.found).toBe(true);
  });

  it("NA29: the commit decides, not wherever the read happened to stop", function* () {
    // The same bytes cut three ways. A frame is finished by `?2026l` and not by
    // an operating system choosing where one `data` event ends, so an observer
    // that evaluated per read would answer differently for each of these.
    const held = `${SYNC_ON}${paint(["", "", ANSWER])}`;
    const replaced = paint(["", "", "Working on it."]);
    const cuts: [string, readonly string[], boolean][] = [
      ["one read", [`${held}${replaced}${SYNC_OFF}`], false],
      ["cut mid-frame", [held, `${replaced}${SYNC_OFF}`], false],
      ["committed, then overdrawn in the next read", [`${held}${SYNC_OFF}`, replaced], true],
      // The one that can only be got right where the frame ends: the answer was
      // committed and then drawn over, and the read carrying both stops after.
      ["committed and overdrawn inside one read", [`${held}${SYNC_OFF}${replaced}`], true],
    ];

    for (const [name, reads, latches] of cuts) {
      const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
      watch.write(ALT_ON);
      watch.ask(asked());
      for (const read of reads) {
        watch.write(read);
      }
      expect(`${name}: ${watch.found}`).toBe(`${name}: ${latches}`);
    }
  });

  it("NA30: begin and end split across byte reads still bound the frame", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());

    const bytes = new TextEncoder().encode(
      `${SYNC_ON}${paint(["", "", ANSWER])}${paint(["", "", "Working on it."])}${SYNC_OFF}` +
        `${SYNC_ON}${paint(["", "", ANSWER])}${SYNC_OFF}`,
    );
    // One byte at a time, which splits `?2026h` and `?2026l` down the middle
    // repeatedly. The first frame erased its answer and the second kept it.
    const answeredAt: number[] = [];
    for (let index = 0; index < bytes.length; index += 1) {
      if (watch.write(bytes.subarray(index, index + 1))) {
        answeredAt.push(index);
      }
    }

    expect(watch.found).toBe(true);
    // Nothing latched until the second frame committed, which is the last byte.
    expect(answeredAt[0]).toBe(bytes.length - 1);
  });

  it("NA31: bytes that never went through the terminal cannot answer", function* () {
    const seen: string[] = [];
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    const channels = terminalChannels((chunk) => {
      seen.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    }, watch);
    channels.display(ALT_ON);
    watch.ask(asked());

    // `script` reports its own troubles beside the pty. Those bytes reached
    // this process without ever being displayed, so however exactly they read,
    // they are not something an operator could have been looking at.
    const beside = `${paint(["", "", ANSWER])}\n${ANSWER}\n`;
    const before = watch.snapshot();
    channels.diagnostic(beside);

    expect(channels.observing).toBe(true);
    expect(watch.found).toBe(false);
    expect(watch.snapshot()).toEqual(before);
    // Still evidence about the run, which is the other half of the split.
    expect(seen.join("")).toContain(ANSWER);

    // And the same bytes on the channel the terminal presented do answer.
    expect(channels.display(paint(["", "", ANSWER]))).toBe(true);
  });

  it("NA32: every invocation reads a terminal, only the submitting one watches", function* () {
    const size = { rows: ROWS, columns: COLUMNS };
    const submitted = { say: TYPED, expect: ANSWER };
    // The one invocation that submits: a journey's first, saying something and
    // expecting an answer to it.
    expect(terminalReader(size, { index: 0, ...submitted }).watching).toBe(true);

    // Preflight and both zero-native-turn invocations, which pass an empty plan.
    expect(terminalReader(size, { index: 0 }).watching).toBe(false);
    expect(terminalReader(size, { index: 1 }).watching).toBe(false);
    // Re-entry is not the invocation that submits, so an expectation reaching it
    // is a mistake and not a second thing to watch.
    expect(terminalReader(size, { index: 1, ...submitted }).watching).toBe(false);
    // Neither half is enough on its own: expecting without saying observes a
    // turn nobody sent, and saying without expecting has nothing to look for.
    expect(terminalReader(size, { index: 0, expect: ANSWER }).watching).toBe(false);
    expect(terminalReader(size, { index: 0, say: TYPED }).watching).toBe(false);
    expect(terminalReader(size, { index: 0, say: TYPED, expect: "" }).watching).toBe(false);

    const seen: string[] = [];
    const reader = terminalReader(size, { index: 0 });
    const channels = terminalChannels(
      (chunk) => seen.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
      reader,
    );

    expect(channels.observing).toBe(false);
    expect(channels.display(`${ALT_ON}${paint(["", "", ANSWER])}`)).toBe(false);
    channels.diagnostic(ANSWER);
    // The stream is still kept whole, because it is this run's evidence.
    expect(seen.join("")).toContain(ANSWER);

    // The screen is built all the same, because this invocation still has to
    // decide what surface it is looking at.
    expect(screenShows(reader.snapshot(), ANSWER)).toBe(true);
    // And it cannot be asked for an answer: it submitted no turn, so a reply it
    // reported would be attributed to one nobody spent.
    expect(() => reader.ask(asked())).toThrow("submits no turn");
    expect(reader.found).toBe(false);
  });

  it("NA33: a surface only a held frame contains is not what the terminal showed", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());

    // What the operator is looking at when a wait for an answer gives up, and
    // what naming the terminal's state means: `still-working`.
    watch.write(paint(["", pane("esc to interrupt")]));
    const presented = watch.snapshot();
    expect(screenShows(presented, "esc to interrupt")).toBe(true);

    // Now a repaint begins. Inside it the pane is erased and a refusal is laid
    // down — cells the terminal is holding, which nobody was shown. A reader of
    // those would report `usage-limited` and send the next reader off to check
    // a plan that was never at fault.
    watch.write(`${SYNC_ON}${CLEAR}${paint(["", pane("You've hit your usage limit.")])}`);
    expect(watch.snapshot()).toEqual(presented);
    expect(screenShows(watch.snapshot(), "usage limit")).toBe(false);

    // Still the frame before, however many reads the repaint takes.
    watch.write(paint(["", "", pane("Working on it.")]));
    expect(watch.snapshot()).toEqual(presented);
    expect(screenShows(watch.snapshot(), "esc to interrupt")).toBe(true);

    // And it advances at the commit, to exactly what the commit put on show.
    watch.write(SYNC_OFF);
    expect(screenShows(watch.snapshot(), "Working on it.")).toBe(true);
    expect(screenShows(watch.snapshot(), "esc to interrupt")).toBe(false);
    expect(screenShows(watch.snapshot(), "usage limit")).toBe(false);
    // The answer was never on any of it, held or shown.
    expect(watch.found).toBe(false);
  });

  it("NA34: a hold beginning mid-read presents the bytes before it, not after", function* () {
    const watch = new TerminalReader({ rows: ROWS, columns: COLUMNS }, true);
    watch.write(ALT_ON);
    watch.ask(asked());

    // One read that finishes drawing one surface and then starts withholding
    // the next. What was presented is where the hold began, not where the
    // operating system stopped the read.
    watch.write(
      `${paint(["", pane("esc to interrupt")])}` +
        `${SYNC_ON}${CLEAR}${paint(["", pane("Ask Codex to do anything")])}`,
    );
    expect(screenShows(watch.snapshot(), "esc to interrupt")).toBe(true);
    expect(screenShows(watch.snapshot(), "Ask Codex to do anything")).toBe(false);

    // The commit, and the next hold, one byte at a time — which splits both
    // sequences down the middle. The composer frame is presented as it commits,
    // and the answer drawn after it is held back by the frame that follows.
    const bytes = new TextEncoder().encode(
      `${SYNC_OFF}${SYNC_ON}${CLEAR}${paint(["", "", ANSWER])}`,
    );
    for (let index = 0; index < bytes.length; index += 1) {
      watch.write(bytes.subarray(index, index + 1));
    }

    expect(screenShows(watch.snapshot(), "Ask Codex to do anything")).toBe(true);
    expect(screenShows(watch.snapshot(), ANSWER)).toBe(false);
    expect(watch.found).toBe(false);

    // Committing it shows both what it drew and that it answered.
    expect(watch.write(SYNC_OFF)).toBe(true);
    expect(screenShows(watch.snapshot(), ANSWER)).toBe(true);
  });
});
