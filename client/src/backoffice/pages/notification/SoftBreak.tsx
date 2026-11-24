import { Fragment } from 'react'

/** Emails and template codes: allow a line break after "@", "_" and "." only, never in the middle of a word. */
export function SoftBreak({ text }: { text: string }) {
  return (
    <>
      {text.split(/(?<=[@_.])/).map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  )
}
