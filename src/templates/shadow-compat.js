// src/templates/shadow-compat.js
//
// Inline <style> block injected into every knowledge base page by Base.astro.
//
// @tailwindcss/vite strips custom element selectors (wf-html, wf-document) during
// its CSS optimisation pass, making it impossible to target shadow DOM elements
// via the external style.css file alone. Injecting these rules as an inline
// <style> tag places them inside the shadow root's stylesheet scope, where they
// work without going through the Tailwind pipeline.
//
// wf-html / wf-document get explicit declarations of every design token, so
// shadow-root elements have them directly. Belt-and-suspenders — :root and :host
// in knowledge-base.css already cover inheritance, but direct assignment avoids any
// edge-case inheritance break inside a reframed fragment.
//
// The knowledge base is light-only: there is no dark-mode override here or anywhere
// else, so an embedding host's own dark theme can never bleed into the fragment.

export const shadowCompatStyle = `
<style>
wf-html,wf-document{--color-kb-25:#fdf8f9;--color-kb-50:#f8eaee;--color-kb-100:#f0d0da;--color-kb-400:#d4547a;--color-kb-500:#af144b;--color-kb-600:#93103f;--color-kb-950:#1b0e12;--font-sans:Inter,"Noto Sans",ui-sans-serif,system-ui,sans-serif;--font-mono:"SF Mono","Fira Code","Fira Mono",ui-monospace,monospace;--bg-page:#fdf8f9;--bg-card:#fff;--bg-strong:oklch(98.5% .002 247.839);--bg-subtle:oklch(96.7% .003 264.542);--border:oklch(92.8% .006 264.531);--border-subtle:#f3e7eb;--text-heading:#1b0e12;--text-body:oklch(44.6% .03 256.802);--text-muted:oklch(55.1% .027 264.364);--text-hint:oklch(70.7% .022 261.325);--shadow-sm:0 1px 2px rgba(0,0,0,.04);--shadow-md:0 4px 12px rgba(0,0,0,.08);--shadow-lg:0 8px 24px rgba(0,0,0,.12);--radius-sm:6px;--radius-md:12px;--radius-lg:16px;--radius-xl:20px;--transition:.2s}
</style>`.trim();
