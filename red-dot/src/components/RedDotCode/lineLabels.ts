// The speech-to-text under each line: plain HTML text over the canvas (no React, no WebGL).
// The animation loop calls sync() every frame, so the text follows its line when it's dragged.
//
//   const labels = createLabels(container)        // container: an element over the canvas
//   labels.sync(lines, pending, size)             // every frame
//   labels.dispose()
//
// pending: the text of the line that is still being spoken, shown where that line will appear.
// While the text can still change it's dimmer and italic; once final, it shows the confidence.

import { halfExtent } from './utteranceLines.ts'
import type { LineText, Size, UtteranceLine } from './utteranceLines.ts'

export interface PendingText {
  text: LineText
  at: [x: number, y: number]   // where the next line will be, as a share of the canvas (like a line's centre)
}

export interface Labels {
  sync(lines: UtteranceLine[], pending: PendingText | null, size: Size): void
  dispose(): void
}

interface Label {
  el: HTMLDivElement
  shown: string      // what it shows now, to touch the page only when something changes
  x: number
  y: number
}

const GAP_PX = 6     // between the line's wave and its text

export function createLabels(container: HTMLElement): Labels {
  const labels = new Map<string, Label>()   // by line id, and "pending"

  function place(key: string, text: LineText, center: [number, number], size: Size, seen: Set<string>): void {
    seen.add(key)
    let label = labels.get(key)
    if (!label) {
      const el = document.createElement('div')
      el.className = 'reddot-label'
      container.append(el)
      label = { el, shown: '', x: NaN, y: NaN }
      labels.set(key, label)
    }
    const [hx, hy] = halfExtent(size)
    const x = Math.round(center[0] * size.width)
    const y = Math.round(center[1] * size.height + hy + GAP_PX)
    if (x !== label.x || y !== label.y) {
      label.el.style.transform = `translate(${x}px, ${y}px) translateX(-50%)`
      label.el.style.maxWidth = `${Math.round(hx * 2.4)}px`
      label.x = x
      label.y = y
    }
    const shown = JSON.stringify(text)
    if (shown !== label.shown) {
      label.shown = shown
      render(label.el, text)
    }
  }

  function sync(lines: UtteranceLine[], pending: PendingText | null, size: Size): void {
    const seen = new Set<string>()
    for (const line of lines) {
      if (line.text) place(String(line.id), line.text, line.center, size, seen)
    }
    if (pending) place('pending', pending.text, pending.at, size, seen)
    for (const [key, label] of labels) {  // lines that were dropped, or the pending text that's gone
      if (!seen.has(key)) {
        label.el.remove()
        labels.delete(key)
      }
    }
  }

  function dispose(): void {
    for (const label of labels.values()) label.el.remove()
    labels.clear()
  }

  return { sync, dispose }
}

function render(el: HTMLDivElement, { text, final, confidence }: LineText): void {
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
}
