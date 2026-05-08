/**
 * scheduler-guard.ts — Never-automate-calls / never-first-touch-auto-reply guard.
 *
 * PURPOSE (SY-011 / W7.3):
 * ────────────────────────────────────────────────────────────────────────────
 * The exec explicitly stated that two types of outreach must NEVER be automated:
 *
 *   1. Phone calls — we never auto-dial or produce automated voice/call content.
 *   2. First-touch replies to prospect inquiries — the exec must personally
 *      respond to the first inbound message from a new prospect; no auto-reply.
 *
 * `assertNotAutomatedOutbound` is a defensive scaffold.  It is currently called
 * from the autodraft generation path (Stream B) and is intended to be called
 * from any future scheduler, digest, or outreach automation.
 *
 * CONTRACT:
 * ──────────
 *   - `channel === "phone"` → always throws, regardless of `isFirstTouch`.
 *   - `channel === "email" && isFirstTouch === true` → throws; the exec must
 *     send the first reply themselves.
 *   - `channel === "email" && isFirstTouch === false` → passes; drafts for
 *     ongoing email conversations are fine.
 *
 * The function throws `AutomationForbiddenError` (a subclass of `Error`) so
 * callers can distinguish this guard from other errors via `instanceof`.
 *
 * NOTE: This guard does not prevent the exec from manually sending an email or
 * picking up a phone.  It only gates the *automated* path — code that would
 * initiate or reply without explicit human review and action.
 */

// ── Error type ────────────────────────────────────────────────────────────────

export class AutomationForbiddenError extends Error {
  /** The channel that triggered the guard. */
  readonly channel: "phone" | "email";
  /** Whether this was flagged as a first-touch scenario. */
  readonly isFirstTouch: boolean;

  constructor(
    message: string,
    channel: "phone" | "email",
    isFirstTouch: boolean,
  ) {
    super(message);
    this.name = "AutomationForbiddenError";
    this.channel = channel;
    this.isFirstTouch = isFirstTouch;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Assert that the proposed outbound action is not in the set of permanently-
 * forbidden automation targets (SY-011).
 *
 * @param target.channel      "phone" or "email".
 * @param target.isFirstTouch true if this would be the first message ever sent
 *                            to the prospect / contact on this channel.
 *
 * @throws {AutomationForbiddenError} when:
 *   - channel is "phone" (we never automate phone outreach), OR
 *   - channel is "email" and isFirstTouch is true (exec must send first reply).
 *
 * @example
 * ```ts
 * // Inside generateAutodraft or any scheduler:
 * assertNotAutomatedOutbound({ channel: "email", isFirstTouch: false });
 * // ^ passes — follow-up draft for an ongoing conversation is allowed.
 *
 * assertNotAutomatedOutbound({ channel: "phone", isFirstTouch: false });
 * // ^ throws — phone automation is always forbidden.
 *
 * assertNotAutomatedOutbound({ channel: "email", isFirstTouch: true });
 * // ^ throws — first-touch prospect replies are never automated.
 * ```
 */
export function assertNotAutomatedOutbound(target: {
  channel: "phone" | "email";
  isFirstTouch: boolean;
}): void {
  if (target.channel === "phone") {
    throw new AutomationForbiddenError(
      "Automated phone outreach is permanently forbidden (SY-011 / W7.3). " +
        "The exec must initiate or respond to calls personally.",
      "phone",
      target.isFirstTouch,
    );
  }

  if (target.isFirstTouch) {
    throw new AutomationForbiddenError(
      "Automated first-touch replies to prospect inquiries are permanently " +
        "forbidden (SY-011 / W7.3). The exec must personally respond to " +
        "the first inbound message from a new prospect.",
      "email",
      true,
    );
  }
}
