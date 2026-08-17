/** Minimal Cloudflare Pages / HTMLRewriter types for the meta worker bundle. */

interface HTMLRewriterElement {
  setInnerContent(content: string): void;
  setAttribute(name: string, value: string): void;
}

interface HTMLRewriterElementContentHandlers {
  element(element: HTMLRewriterElement): void;
}

declare class HTMLRewriter {
  on(selector: string, handlers: HTMLRewriterElementContentHandlers): HTMLRewriter;
  transform(response: Response): Response;
}
