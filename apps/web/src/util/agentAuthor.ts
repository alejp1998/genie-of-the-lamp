/** Agent commits: Claude's (MCP connector) and "<person> (via <agent>)" from an assistant acting for someone. */
export function isAgentAuthor(author: string | undefined): boolean {
  return !!author && (author === 'Claude' || / \(via [A-Za-z0-9][A-Za-z0-9 ._-]{0,39}\)$/.test(author));
}

/** Who to name in a review prompt for these commits: the one author, else a neutral word. */
export function agentDisplayName(authors: Array<string | undefined>): string {
  const distinct = [...new Set(authors.filter(isAgentAuthor))];
  if (distinct.length === 1) return distinct[0]!;
  return distinct.length ? 'Agents' : 'Claude';
}
