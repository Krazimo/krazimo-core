/**
 * How what we remember about a person reaches the model.
 *
 * The brief is prepended to the user's message rather than added to the system
 * prompt, and that is deliberate: the system prompt is byte-identical on every
 * step of a turn and therefore the cheapest thing to cache, while the brief
 * changes per person. Moving it up there would break the cache on every call.
 *
 * The cost of that choice was found in review. Sitting immediately before the
 * question, an unlabelled "products they own: Lavender, Peppermint" reads as a
 * shortlist to answer from, and it beat a constitution that said to lead with
 * what the shelf ranks first — because the shelf rule was thousands of tokens
 * earlier and this was right here. Asked about aching legs, the mentor opened
 * with Peppermint, which that shelf files under "also helps, if they have it".
 *
 * So the facts stay where they are and gain a frame. Knowing what someone owns
 * is what makes an answer usable tonight; it is not what decides the
 * recommendation, and the brief now says so in the same breath as the facts.
 */

/** The user turn as the model should see it: framed background, then the question. */
export function composeUserMessage(brief: string | undefined, message: string): string {
	if (!brief?.trim()) return message;
	return (
		"[background on this person — use it to tailor HOW you answer and what " +
		"they can act on tonight. It is not a shortlist to recommend from, and " +
		"owning something is not a reason to name it first.]\n" +
		`${brief.trim()}\n` +
		"[end of background]\n\n" +
		message
	);
}
