// The speech-to-text inside each bubble: plain HTML text over the canvas (no React, no WebGL).
// The animation loop calls sync() every frame, so the text follows its bubble when it moves.
//
//   const labels = createLabels(container)             // container: an element over the canvas
//   labels.sync(bubbles, live, size)                   // every frame
//   labels.scrollBy(bubble, dy)                        // the mouse wheel over a bubble scrolls its text
//   labels.dispose()
//
// A bubble's text is that of its utterances, one after the other; live: what is being said right
// now (in Live mode), added to the text of the bubble it belongs to. While text can still change it's dimmer and italic; once
// all of it is final, it shows the confidence. The text is about as big as its bubble (it may run
// over the outline); a longer one scrolls, and follows the newest text unless it was scrolled
// back to read. It never takes the pointer: taps and drags go to the bubble (canvas) below.

import { BUBBLE } from './looks.ts'
import type { LineText, Size, SpeechBubble } from './speechBubbles.ts'

/** What is being said right now, and the bubble it belongs to. */
export interface LiveText {
  bubble: SpeechBubble
  text: LineText
}

export interface Labels {
  sync(bubbles: SpeechBubble[], live: LiveText | null, size: Size): void
  scrollBy(bubble: SpeechBubble, dy: number): void
  dispose(): void
}

interface Label {
  el: HTMLDivElement
  shown: string      // what it shows now, to touch the page only when something changes
  x: number
  y: number
  width: number
  height: number
}

const MIN_WIDTH_PX = 110   // a small bubble's text may be wider than the bubble...
const MIN_LINES = 2        // ...and taller

export function createLabels(container: HTMLElement): Labels {
  const labels = new Map<number, Label>()   // by bubble id

  function place(bubble: SpeechBubble, text: LineText, size: Size): void {
    let label = labels.get(bubble.id)
    if (!label) {
      const el = document.createElement('div')
      el.className = 'reddot-label'
      el.addEventListener('scroll', () => el.classList.toggle('more-above', el.scrollTop > 0))
      container.append(el)
      label = { el, shown: '', x: NaN, y: NaN, width: NaN, height: NaN }
      labels.set(bubble.id, label)
    }
    // In the middle of the bubble (as big as it is now, without popping and breathing), a little
    // smaller than its oval.
    const ry = bubble.radius * Math.min(size.width, size.height)
    const x = Math.round(bubble.center[0] * size.width)
    const y = Math.round(bubble.center[1] * size.height)
    const width = Math.round(Math.min(size.width - 16, Math.max(MIN_WIDTH_PX, ry * BUBBLE.aspect * 2 * 0.8)))
    const height = Math.round(ry * 2 * 0.75)
    let resized: boolean | null = null   // resized: was it showing the end of its text before?
    if (width !== label.width || height !== label.height) {
      resized = isAtEnd(label.el)
      label.el.style.maxWidth = `${width}px`
      label.el.style.maxHeight = `max(${MIN_LINES * 1.35}em, ${height}px)`
      label.width = width
      label.height = height
    }
    if (x !== label.x || y !== label.y) {
      label.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
      label.x = x
      label.y = y
    }
    const shown = JSON.stringify(text)
    if (shown !== label.shown) {
      label.shown = shown
      render(label.el, text)
    } else if (resized !== null) {
      followNewest(label.el, resized)  // it may (not) need to scroll now
    }
  }

  function sync(bubbles: SpeechBubble[], live: LiveText | null, size: Size): void {
    const seen = new Set<number>()
    for (const bubble of bubbles) {
      const text = bubbleText(bubble, live?.bubble === bubble ? live.text : null)
      if (!text) continue
      seen.add(bubble.id)
      place(bubble, text, size)
    }
    for (const [id, label] of labels) {  // bubbles that were dropped, or have no text (any more)
      if (!seen.has(id)) {
        label.el.remove()
        labels.delete(id)
      }
    }
  }

  function scrollBy(bubble: SpeechBubble, dy: number): void {
    labels.get(bubble.id)?.el.scrollBy({ top: dy })
  }

  function dispose(): void {
    for (const label of labels.values()) label.el.remove()
    labels.clear()
  }

  return { sync, scrollBy, dispose }
}

/** All of a bubble's text: its utterances' texts, then what is being said (live). null: none yet
 *  (speech-to-text off, or nothing has come for it). */
function bubbleText(bubble: SpeechBubble, live: LineText | null): LineText | null {
  const parts = bubble.utterances.flatMap((u) => (u.text ? [u.text] : []))
  if (live) parts.push(live)
  if (parts.length === 0) return null
  const confidences = parts.flatMap((p) => (p.final && p.confidence !== null ? [p.confidence] : []))
  return {
    text: parts.map((p) => p.text).filter(Boolean).join(' '),
    final: parts.every((p) => p.final),
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
  }
}

function render(el: HTMLDivElement, { text, final, confidence }: LineText): void {
  // Following the newest text: was it scrolled to the end before this change?
  const atEnd = isAtEnd(el)
  el.classList.toggle('partial', !final)
  el.classList.toggle('empty', !text)
  el.replaceChildren()
  // Nothing yet: "…" while waiting; "–" if the service heard nothing it could write down.
  el.append(text || (final ? '–' : '…'))
  if (final && text && confidence !== null) {
    const c = document.createElement('span')
    c.className = 'confidence'
    c.textContent = `${Math.round(confidence * 100)}%`
    c.title = 'how sure the service is (its own measure: not comparable between services)'
    el.append(c)
  }
  followNewest(el, atEnd)
}

function isAtEnd(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 4
}

/** Too long for its height: show the newest text if it was showing the end before. While there
 *  is text above, it fades out at the top ("more-above", also kept up to date while scrolling). */
function followNewest(el: HTMLDivElement, atEnd: boolean): void {
  const scrolls = el.scrollHeight > el.clientHeight + 1
  if (scrolls && atEnd) el.scrollTop = el.scrollHeight
  el.classList.toggle('more-above', scrolls && el.scrollTop > 0)
}
