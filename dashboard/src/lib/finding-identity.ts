/**
 * What the identity of a scan finding IS — one definition, both halves.
 *
 * ============================================================================
 * WHY THIS IS NOT TWO FUNCTIONS
 *
 * Two things ask the same question about a finding and they live on opposite
 * sides of the wire. `server/findings.ts` derives the promoted alert's id from
 * it, which is what makes two presses on one finding of one scan a single case
 * (`soc_ingested_alerts` is keyed on `alert_id` with no expiry). And the report
 * screen asks it of the cases the browser already holds, to find out whether a
 * finding it is showing has already been through that door (J0.5).
 *
 * `CLAUDE.md` settled this shape once already, for the byte cap: *"`humanBytes`
 * lives in `respond.ts` now and both directions import it, because two
 * spellings of one number is how the two start disagreeing."* Two spellings of
 * an identity would disagree the same way, and the disagreement would be
 * silent — the report would simply stop recognising cases it had opened
 * itself, which is the absence-of-a-claim that nothing fails over.
 *
 * ============================================================================
 * THE MODULE IMPORTS NOTHING, AND THAT IS DELIBERATE
 *
 * It is read by the browser bundle AND by the console API, which runs its
 * TypeScript directly under `node --experimental-strip-types`. A browser-only
 * reference acquired here would break that process AT STARTUP and nowhere
 * else — the parameter-property trap this repository already paid for. With no
 * imports there is nothing to acquire by accident, and a future one has to be
 * written on purpose.
 *
 * ============================================================================
 * THE LINE NUMBER IS ABSENT, AND SO IS THE SCAN
 *
 * The line comes from the model and moves the instant a line is added above
 * it — the reason `vulnpipe/lib/finding-status.ts` leaves it out of its own
 * key, written down before either of these existed.
 *
 * The SCAN RUN is not in here either, and that is a different decision: it is
 * part of the ALERT's identity (a flaw fixed in January and regressed in June
 * must be triageable again) and not part of the FLAW's. The two callers
 * combine it themselves, which is why `findingAlertId` reads
 * `${scanRunId}\0${findingIdentityKey(f)}` rather than taking a five-field
 * key: the flaw is the thing this module names.
 * ============================================================================
 */

/** The four fields that identify a flaw, between two scans and across the wire. */
export interface FindingIdentity {
  vulnerability: string;
  http_method: string;
  route: string;
  file: string;
}

/** Longest single text field copied out of a finding. */
export const FIELD_MAX = 2000;

/**
 * A field, cut to a length, saying that it was cut.
 *
 * IT IS IDEMPOTENT ON PURPOSE and the identity leans on that: the cut is made
 * to exactly `max` characters BEFORE the marker is appended, so clipping an
 * already-clipped value returns it unchanged. That is what lets the report
 * compare a raw finding field against the clipped copy stored on a case
 * without either side having to know which of them was cut.
 */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… (clipped)`;
}

/**
 * The flaw's key: the four fields, normalised the way they are STORED.
 *
 * `\u0000` as the separator, written as an escape rather than as the literal
 * byte it used to be — a NUL in a source file makes the whole file binary to
 * `grep`, so the rule was unreadable in the one place it is implemented. It
 * cannot occur in any of the four parts, which is what stops a value being
 * made to swallow a delimiter and collide with another identity: a space
 * separator would make `{vulnerability: 'A B', http_method: 'G'}` and
 * `{vulnerability: 'A', http_method: 'B G'}` one flaw.
 *
 * Trimmed and clipped, because that is what the writer stores — comparing a
 * raw field against a stored one is how a long route would quietly stop
 * matching the case it opened.
 */
export function findingIdentityKey(identity: FindingIdentity): string {
  return [
    identity.vulnerability,
    identity.http_method,
    identity.route,
    identity.file,
  ].map((part) => clip(part.trim(), FIELD_MAX)).join('\u0000');
}
