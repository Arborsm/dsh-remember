/**
 * Hides the <dsh-mem-citation> block from the rendered chat. The host-side
 * citation loop consumes it from the session log; this stripper keeps the raw
 * XML out of the visible transcript.
 *
 * Implementation: a MutationObserver watches for the marker; when found, the
 * text is truncated at the marker up to (and including) the end tag. React
 * may restore the text on re-render — the observer just strips it again.
 */

const MARKER_OPEN = '<dsh-mem-citation>'
const MARKER_CLOSE = '</dsh-mem-citation>'

/** Strip the citation block inside one element. Returns true when it cut. */
function stripWithin(root: Element): boolean {
  const full = root.textContent ?? ''
  const start = full.indexOf(MARKER_OPEN)
  if (start < 0) return false
  const endIndex = full.indexOf(MARKER_CLOSE, start)
  const cutEnd = endIndex < 0 ? full.length : endIndex + MARKER_CLOSE.length

  // Remove the contiguous [start, cutEnd) range from the concatenated text,
  // tracking how earlier cuts shift the range left.
  let rangeStart = start
  let rangeEnd = cutEnd
  let cut = false
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  let node = walker.nextNode() as Text | null
  while (node != null) {
    const length = node.data.length
    const nodeEnd = offset + length
    if (nodeEnd > rangeStart && offset < rangeEnd) {
      const localStart = Math.max(0, rangeStart - offset)
      const localEnd = Math.min(length, rangeEnd - offset)
      node.data = node.data.slice(0, localStart) + node.data.slice(localEnd)
      rangeEnd -= localEnd - localStart
      cut = true
    }
    offset += node.data.length
    if (offset >= rangeEnd && cut) break
    node = walker.nextNode() as Text | null
  }
  return cut
}

function sweep(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  while (node != null) {
    const next = walker.nextNode() as Text | null
    if (node.data.includes(MARKER_OPEN)) {
      // The block may span sibling elements; climb a few levels to cover it.
      let scope: Element | null = node.parentElement
      for (let depth = 0; depth < 4 && scope != null; depth += 1) {
        if (stripWithin(scope)) break
        scope = scope.parentElement
      }
    }
    node = next
  }
}

/** Install the stripper; returns a disposer. No-ops outside a document. */
export function installCitationStripper(): () => void {
  if (typeof document === 'undefined') return () => {}
  let pending = false
  const schedule = (): void => {
    if (pending) return
    pending = true
    // Batch bursts of stream mutations into one sweep per frame.
    requestAnimationFrame(() => {
      pending = false
      try {
        sweep(document.body)
      } catch {
        // Best effort: a strip failure must never break the chat.
      }
    })
  }
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target
      if (
        (target.nodeType === Node.TEXT_NODE && (target as Text).data.includes(MARKER_OPEN))
        || (target instanceof Element && (target.textContent ?? '').includes(MARKER_OPEN))
      ) {
        schedule()
        return
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  sweep(document.body)
  return () => observer.disconnect()
}
