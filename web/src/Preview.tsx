import { useState } from 'react'
import { fileUrl } from './api'

export function Preview({ id, content }: { id: number; content: string }) {
  const [showText, setShowText] = useState(false)
  return (
    <section className="flex flex-col bg-gray-100 desk:w-1/2">
      <div className="flex gap-4 px-3 py-2 text-sm">
        <button type="button" onClick={() => setShowText((v) => !v)} className="underline">
          {showText ? 'Show document' : 'Show OCR text'}
        </button>
        <a href={fileUrl(id, 'preview')} target="_blank" rel="noreferrer" className="underline">
          Open PDF ↗
        </a>
      </div>
      {showText ? (
        <pre className="max-h-72 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs desk:max-h-none">{content}</pre>
      ) : (
        <>
          <iframe title="Document preview" src={fileUrl(id, 'preview')} className="hidden w-full flex-1 bg-white desk:block" />
          <a href={fileUrl(id, 'preview')} target="_blank" rel="noreferrer" className="flex justify-center p-3 desk:hidden">
            <img src={fileUrl(id, 'thumb')} alt="Document thumbnail" className="max-h-56 bg-white shadow" />
          </a>
        </>
      )}
    </section>
  )
}
