/** 统一的 20px 线性图标，不依赖宿主图标版本。 */
import { createElement, type ReactNode } from 'react'

const paths = {
  selection: 'M7 3H4a1 1 0 0 0-1 1v3m10-4h3a1 1 0 0 1 1 1v3M3 13v3a1 1 0 0 0 1 1h3m10-4v3a1 1 0 0 1-1 1h-3M7 7h6M10 7v6m-2 0h4',
  language: 'M3 5h10M8 3v2m3 0c-1 5-4 8-8 10m2-7c1 3 3 5 6 6m1 3 3-8 3 8m-5-3h4',
  model: 'M6 5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm2 3h4v4H8V8ZM8 2v3m4-3v3M8 15v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3',
  rules: 'M5 3h8l3 3v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v4h4M7 10h6m-6 3h4',
  sparkle: 'm10 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z',
  list: 'M7 5h10M7 10h10M7 15h7M3.5 5h.01M3.5 10h.01M3.5 15h.01',
  check: 'm5 10 3 3 7-7',
  chevron: 'm7 8 3 3 3-3',
  arrow: 'M4 10h12m-4-4 4 4-4 4',
} as const

export function ToolIcon({ name, size = 20 }: { name: keyof typeof paths; size?: number }): ReactNode {
  return createElement('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, createElement('path', { d: paths[name] }))
}
