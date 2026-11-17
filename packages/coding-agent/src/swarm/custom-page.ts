import { randomBytes } from "node:crypto";
import type { NarratorAction } from "@oh-my-pi/pi-tui/overlays/swarm-view-model";
import { exportThemeStyles, webExportThemeVars } from "../export/html/web-palette";
import type { SwarmBoardSource } from "../modes/swarm-board-runtime";
import bridgeScript from "./custom-page-bridge.js.txt" with { type: "text" };
import hostTemplate from "./custom-page.html.txt" with { type: "text" };

const ENCODER = new TextEncoder();
const THEME_ALIASES = `--background: var(--bg); --foreground: var(--fg); --card: var(--bg-raised);
--card-foreground: var(--fg); --border: var(--border-strong); --primary: var(--accent);
--primary-foreground: var(--bg); --muted-foreground: var(--fg-muted); --destructive: var(--err);
--secondary: var(--bg-overlay); --secondary-foreground: var(--fg); --ring: var(--link);`;
const THEME_CSS = exportThemeStyles(
	`${webExportThemeVars("dark")} ${THEME_ALIASES}`,
	`${webExportThemeVars("light")} ${THEME_ALIASES}`,
);
const FRAME_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"img-src data:",
	"font-src 'none'",
	"connect-src 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"worker-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
	"require-trusted-types-for 'script'",
	"trusted-types 'none'",
	"sandbox allow-scripts",
].join("; ");
const PERMISSIONS = [
	"camera=()",
	"microphone=()",
	"geolocation=()",
	"display-capture=()",
	"payment=()",
	"usb=()",
	"serial=()",
	"bluetooth=()",
	"clipboard-read=()",
	"clipboard-write=()",
	"fullscreen=()",
].join(", ");

export interface SwarmCustomPageOptions {
	source: SwarmBoardSource;
	onNavigate(action: NarratorAction): void | Promise<void>;
	appearance?: "dark" | "light";
	reducedMotion?: boolean;
}

/** One open event stream; `stale` marks state its reader has yet to receive. */
interface PageStream {
	controller: ReadableStreamDefaultController<Uint8Array>;
	stale: boolean;
}

/** A loopback-only, event-driven host for one board's opaque narrator frame. */
export class SwarmCustomPageServer {
	readonly url: string;
	readonly #hostPath = `/page/${randomBytes(24).toString("hex")}/`;
	readonly #framePath = `/frame/${randomBytes(24).toString("hex")}`;
	readonly #nonce = randomBytes(24).toString("base64");
	readonly #server: Bun.Server<undefined>;
	readonly #unsubscribe: () => void;
	readonly #streams = new Set<PageStream>();
	#closed = false;

	constructor(readonly options: SwarmCustomPageOptions) {
		options.source.refresh();
		if (!options.source.customPageHtml) throw new Error("This swarm has no available custom page");
		this.#unsubscribe = options.source.subscribe(() => {
			for (const stream of this.#streams) this.#send(stream);
		});
		try {
			this.#server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				maxRequestBodySize: 8_192,
				fetch: request => this.#handle(request),
			});
			this.#server.unref();
			this.url = new URL(this.#hostPath, this.#server.url).href;
		} catch (error) {
			this.#unsubscribe();
			throw error;
		}
	}

	#event(): Uint8Array {
		const state = this.options.source.getState();
		return ENCODER.encode(
			`data: ${JSON.stringify({
				title: state.title,
				head: state.head,
				view: state.view,
				revision: state.customPageRevision,
				error: state.error ?? state.customPageError ?? state.viewError,
			})}\n\n`,
		);
	}

	/** Every event is a full snapshot, so a reader that falls behind receives only the latest one. */
	#send(stream: PageStream): void {
		try {
			if ((stream.controller.desiredSize ?? 0) > 0) {
				stream.stale = false;
				stream.controller.enqueue(this.#event());
			} else {
				stream.stale = true;
			}
		} catch {
			this.#streams.delete(stream);
		}
	}

	async #handle(request: Request): Promise<Response> {
		const origin = this.#server.url.origin;
		const url = new URL(request.url);
		const requestOrigin = request.headers.get("origin");
		const headers = new Headers({
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Permissions-Policy": PERMISSIONS,
			"X-DNS-Prefetch-Control": "off",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
		});
		if (
			this.#closed ||
			url.origin !== origin ||
			request.headers.get("host") !== this.#server.url.host ||
			(requestOrigin !== null && requestOrigin !== origin)
		)
			return new Response("Forbidden", { status: 403, headers });
		if (url.pathname === this.#hostPath && request.method === "GET") {
			headers.set("Content-Type", "text/html; charset=utf-8");
			headers.set(
				"Content-Security-Policy",
				[
					"default-src 'none'",
					`script-src 'nonce-${this.#nonce}'`,
					`style-src 'nonce-${this.#nonce}'`,
					"connect-src 'self'",
					`frame-src ${origin}${this.#framePath}`,
					"frame-ancestors 'none'",
					"base-uri 'none'",
					"form-action 'none'",
					"object-src 'none'",
				].join("; "),
			);
			const config = JSON.stringify({
				events: `${this.#hostPath}events`,
				navigate: `${this.#hostPath}navigate`,
				frame: this.#framePath,
				reducedMotion: this.options.reducedMotion ?? false,
			}).replaceAll("<", "\\u003c");
			let html = hostTemplate
				.replaceAll("{{NONCE}}", this.#nonce)
				.replace("{{THEME}}", THEME_CSS)
				.replace("{{CONFIG}}", config);
			if (this.options.appearance)
				html = html.replace('<html lang="en">', `<html lang="en" data-theme="${this.options.appearance}">`);
			return new Response(html, { headers });
		}
		if (url.pathname === this.#framePath && request.method === "GET") {
			if (request.headers.get("sec-fetch-dest") !== "iframe")
				return new Response("Embedded page required", { status: 403, headers });
			const html = this.options.source.customPageHtml;
			if (html === undefined) return new Response("Custom page unavailable", { status: 404, headers });
			headers.set("Content-Type", "text/html; charset=utf-8");
			headers.set("Content-Security-Policy", `${FRAME_CSP}; frame-ancestors ${origin}`);
			const bridge = bridgeScript.replace("__OMP_HOST_ORIGIN__", JSON.stringify(origin));
			const theme = this.options.appearance ? ` data-theme="${this.options.appearance}"` : "";
			const motion = `:root[data-omp-reduced-motion="true"] *, :root[data-omp-reduced-motion="true"] *::before, :root[data-omp-reduced-motion="true"] *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }`;
			const prefix = `<!doctype html><html${theme}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${THEME_CSS}\nbody { background: var(--background); color: var(--foreground); font: 14px/1.5 system-ui, sans-serif; margin: 0; }\n@media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }\n${motion}</style><script>${bridge}</script></head><body>`;
			return new Response(`${prefix}${html}</body></html>`, { headers });
		}
		if (url.pathname === `${this.#hostPath}events` && request.method === "GET") {
			headers.set("Content-Type", "text/event-stream; charset=utf-8");
			let active: PageStream;
			const stream = new ReadableStream<Uint8Array>({
				start: controller => {
					active = { controller, stale: true };
					this.#streams.add(active);
					this.#send(active);
				},
				pull: () => {
					if (active.stale) this.#send(active);
				},
				cancel: () => {
					this.#streams.delete(active);
				},
			});
			return new Response(stream, { headers });
		}
		if (url.pathname === `${this.#hostPath}navigate` && request.method === "POST") {
			if (
				requestOrigin !== origin ||
				request.headers.get("x-omp-swarm") !== "navigate" ||
				request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
			)
				return new Response("A host navigation request is required", { status: 403, headers });
			try {
				if (!this.options.source.customPageHtml) throw new Error("Custom page unavailable");
				const value: unknown = await request.json();
				const action = this.options.source.resolveAction(value);
				await this.options.onNavigate(action);
				return new Response(null, { status: 204, headers });
			} catch (error) {
				return new Response(error instanceof Error ? error.message : String(error), { status: 400, headers });
			}
		}
		return new Response("Not found", { status: 404, headers });
	}

	async dispose(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		for (const stream of this.#streams) {
			try {
				stream.controller.close();
			} catch {
				/* A disconnected reader already owns its close. */
			}
		}
		this.#streams.clear();
		await this.#server.stop(true);
	}
}
