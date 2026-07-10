/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted and trimmed
 * to the self-contained EPUB export closure for AI Focused Editor.
 *
 * AI-focused-editor changes:
 * - dropped the 3 dead imports (DependencyManager, PathResolver, MetadataManager);
 * - added `addChapterFromContent` so the Theia backend can drive EPUB from
 *   in-memory, semantic-tag-stripped chapter text (no re-read from disk);
 * - added `setNavTree` so nested manuscript folders (parts) become nested NCX
 *   navPoints, with per-chapter headings still nested underneath;
 * - the Bun `zip` fast path is now optional and falls back to the built-in
 *   Node ZIP writer (the Theia backend runs under Node).
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { ContentProcessor } from "./ContentProcessor";
import { LinkResolver } from "./LinkResolver";
import { convertMarkdownToTelegraphNodes } from "./markdownConverter";
import type { TelegraphNode } from "./telegraph-node";
import { AnchorGenerator, type HeadingInfo } from "./AnchorGenerator";
import { slugifyBase } from "./slug";

/**
 * A node in the EPUB navigation tree used to build a nested NCX (parts/chapters).
 * A folder ("part") sets `children` and leaves `chapterId` undefined; a chapter
 * leaf sets `chapterId` (matching a chapter added via `addChapterFromContent`).
 */
export interface EpubNavPoint {
  title: string;
  chapterId?: string;
  children: EpubNavPoint[];
}

/**
 * EPUB Generator that reuses the existing Telegraph publication mechanism
 * Converts TelegraphNode JSON structure to EPUB format
 */
export class EpubGenerator {
	private outputPath: string;
	private title: string;
	private author: string;
	private language: string;
	private identifier: string;
	private cover?: string;
	private debug?: boolean;
	private zipStrategy: "auto" | "manual";
	private navTree?: EpubNavPoint[];
	private chapters: Array<{
		title: string;
		content: TelegraphNode[];
		id: string;
		sourcePath: string;
		headings: HeadingInfo[];
	}> = [];
	private chapterPathMap: Map<string, string> = new Map();
	/**
	 * OEBPS-relative href of the embedded cover image (e.g. `images/cover.png`),
	 * populated during `generate()` once the cover is confirmed to exist. Undefined
	 * means the EPUB is built without a cover.
	 */
	private coverImageHref?: string;

	constructor(options: {
		outputPath: string;
		title: string;
		author: string;
		language?: string;
		identifier?: string;
		cover?: string;
		debug?: boolean;
		/**
		 * ZIP writer strategy. "auto" uses the Bun `zip` fast path when available
		 * and falls back to the built-in Node writer; "manual" always uses the
		 * built-in Node writer (used to exercise the Node fallback in tests).
		 */
		zipStrategy?: "auto" | "manual";
	}) {
		this.outputPath = resolve(options.outputPath);
		this.title = options.title;
		this.author = options.author;
		this.language = options.language || "ru";
		this.identifier = options.identifier || `epub-${Date.now()}`;
		this.cover = options.cover ? resolve(options.cover) : undefined;
		this.debug = options.debug;
		this.zipStrategy = options.zipStrategy || "auto";
	}

	/**
	 * Provide a nested navigation tree (parts/chapters) so the NCX reflects the
	 * manuscript folder hierarchy. When set, `generateNcx` builds nested navPoints
	 * from this tree instead of the flat chapter list. Chapter leaves reference a
	 * `chapterId` returned by `addChapterFromContent`.
	 */
	setNavTree(nodes: EpubNavPoint[]): void {
		this.navTree = nodes;
	}

	/**
	 * Add a chapter from already-loaded Markdown content (no disk read).
	 *
	 * Used by the AI Focused Editor backend, which reads chapter text itself,
	 * strips semantic `[[kind:id|label]]` tags, and passes the plain Markdown here.
	 * Returns the chapter id (e.g. `chapter-3`) for wiring into the nav tree.
	 */
	addChapterFromContent(options: {
		title: string;
		content: string;
		sourcePath?: string;
		generateToc?: boolean;
	}): string {
		const chapterTitle = options.title;

		// Drop a leading H1 that duplicates the chapter title so the EPUB does not
		// render both the injected <h1> and a converted markdown heading.
		const contentWithoutDuplicateTitle = ContentProcessor.removeDuplicateTitle(
			options.content,
			chapterTitle,
		);

		// Extract headings for the nested NCX (same logic as addChapterFromFile).
		const headings = AnchorGenerator.parseHeadingsFromContent(contentWithoutDuplicateTitle);

		// Convert markdown to TelegraphNode[]; no inline ToC for EPUB (the NCX
		// provides navigation), heading ids come from the unified slug convention.
		const nodes = convertMarkdownToTelegraphNodes(contentWithoutDuplicateTitle, {
			generateToc: options.generateToc === true,
			inlineToC: false,
			tocSeparators: false,
			target: "epub",
		});

		const chapterId = `chapter-${this.chapters.length + 1}`;
		this.chapters.push({
			title: chapterTitle,
			content: nodes,
			id: chapterId,
			sourcePath: options.sourcePath ? resolve(options.sourcePath) : "",
			headings,
		});
		return chapterId;
	}

	/**
	 * Transform legacy list-based table representation (ol/li/ul/li "Header: Value")
	 * into semantic table nodes for EPUB output.
	 */
	private transformListTables(nodes: TelegraphNode[]): TelegraphNode[] {
		const transformNode = (node: TelegraphNode | string): TelegraphNode | string => {
			if (typeof node === "string") return node;

			if (node.tag === "ol") {
				const children = node.children || [];
				const liChildren = children.filter(
					(child) => typeof child === "object" && child && (child as TelegraphNode).tag === "li",
				) as TelegraphNode[];

				if (liChildren.length > 0) {
					let looksLikeTable = true;
					const rows: string[][] = [];

					for (const li of liChildren) {
						const liKids = li.children || [];
						const nestedUl = liKids.find(
							(child) => typeof child === "object" && child && (child as TelegraphNode).tag === "ul",
						) as TelegraphNode | undefined;

						if (!nestedUl) {
							looksLikeTable = false;
							break;
						}

						const cellLis = (nestedUl.children || []).filter(
							(child) => typeof child === "object" && child && (child as TelegraphNode).tag === "li",
						) as TelegraphNode[];

						if (cellLis.length === 0) {
							looksLikeTable = false;
							break;
						}

						const rowValues: string[] = [];
						for (const cellLi of cellLis) {
							const cellChildren = cellLi.children || [];
							const first = cellChildren[0];
							if (typeof first !== "string") {
								looksLikeTable = false;
								break;
							}
							const raw = first;
							const sepIndex = raw.indexOf(":");
							if (sepIndex === -1) {
								looksLikeTable = false;
								break;
							}
							const headerPart = raw.slice(0, sepIndex).trim();
							const valuePart = raw.slice(sepIndex + 1).trim();
							rowValues.push(`${headerPart}:${valuePart}`);
						}

						if (!looksLikeTable) {
							break;
						}

						rows.push(rowValues);
					}

					if (looksLikeTable && rows.length > 0) {
						const headerRow = rows[0];
						const headers: string[] = [];
						for (const cell of headerRow) {
							const sepIndex = cell.indexOf(":");
							const headerText =
								sepIndex !== -1 ? cell.slice(0, sepIndex).trim() : cell.trim();
							headers.push(headerText);
						}

						const bodyRows: TelegraphNode[] = rows.map((row) => {
							const cellNodes: TelegraphNode[] = [];
							for (let i = 0; i < headers.length; i++) {
								const cell = row[i] || "";
								const sepIndex = cell.indexOf(":");
								const valueText =
									sepIndex !== -1 ? cell.slice(sepIndex + 1).trim() : cell.trim();
								cellNodes.push({
									tag: "td",
									children: [valueText],
								});
							}
							return {
								tag: "tr",
								children: cellNodes,
							};
						});

						const headerCells: TelegraphNode[] = headers.map((header) => ({
							tag: "th",
							children: [header],
						}));

						return {
							tag: "table",
							children: [
								{
									tag: "thead",
									children: [
										{
											tag: "tr",
											children: headerCells,
										},
									],
								},
								{
									tag: "tbody",
									children: bodyRows,
								},
							],
						};
					}
				}
			}

			if (node.children) {
				node.children = node.children.map((child) => transformNode(child));
			}
			return node;
		};

		return nodes.map((n) => transformNode(n) as TelegraphNode | string) as TelegraphNode[];
	}

	/**
	 * Debug helper: log basic statistics about tables and list-based
	 * table fallbacks for a given chapter. Enabled only when this.debug
	 * is true to avoid noisy output in normal runs.
	 */
	private debugLogTableSummary(sourcePath: string, nodes: TelegraphNode[]): void {
		if (!this.debug) return;

		let tableCount = 0;
		let olAsTableCount = 0;

		const visit = (node: TelegraphNode | string): void => {
			if (typeof node === "string") return;
			if (node.tag === "table") {
				tableCount++;
			}
			if (node.tag === "ol") {
				// Heuristic: ol where each li contains a nested ul with "header: value"
				const children = node.children || [];
				const liChildren = children.filter(
					(child) => typeof child === "object" && child && (child as TelegraphNode).tag === "li",
				) as TelegraphNode[];

				if (liChildren.length > 0) {
					let looksLikeTable = true;
					for (const li of liChildren) {
						const liKids = li.children || [];
						const nestedUl = liKids.find(
							(child) => typeof child === "object" && child && (child as TelegraphNode).tag === "ul",
						) as TelegraphNode | undefined;
						if (!nestedUl) {
							looksLikeTable = false;
							break;
						}
					}
					if (looksLikeTable) {
						olAsTableCount++;
					}
				}
			}

			if (node.children) {
				for (const child of node.children) {
					visit(child);
				}
			}
		};

		for (const n of nodes) {
			visit(n);
		}

		const fileName = basename(sourcePath);
		console.log(
			`[EPUB DEBUG] ${fileName}: tables=${tableCount}, ol-as-table=${olAsTableCount}`,
		);
	}

	/**
	 * Provide an explicit mapping between source markdown files and their
	 * corresponding chapter HTML filenames (e.g. /abs/path.md -> chapter-3.html).
	 * This allows internal links to be rewritten correctly even when the
	 * target chapter is added later in the pipeline.
	 */
	setChapterPathMap(mapping: Record<string, string>): void {
		this.chapterPathMap = new Map<string, string>();
		for (const [key, value] of Object.entries(mapping)) {
			if (key && value) {
				this.chapterPathMap.set(resolve(key), value);
			}
		}
	}

	/**
	 * Add a chapter from markdown file, reusing the same processing pipeline as Telegraph publication
	 */
	async addChapterFromFile(filePath: string, options: {
		generateToc?: boolean;
		inlineToC?: boolean;
		tocTitle?: string;
		tocSeparators?: boolean;
	} = {}): Promise<void> {
		if (this.debug) console.log(`[EPUB DEBUG] Processing chapter file: ${filePath}`);

		// Reuse the same processing pipeline as Telegraph publication:
		// - parse metadata
		// - remove front-matter
		// - remove duplicate H1 that equals metadata title
		const processedContent = ContentProcessor.processFile(filePath);
		const contentWithoutMetadata = processedContent.contentWithoutMetadata;

		// Use the same title extraction strategy as publish:
		// metadata.title → first heading/bold line → short first line → filename.
		const chapterTitle = ContentProcessor.extractTitle(processedContent) || basename(filePath, ".md");

		// Remove duplicate top-level heading that matches the chosen chapter title
		// so that EPUB does not contain both <h1> and a converted markdown heading
		// with the same text.
		const contentWithoutDuplicateTitle = ContentProcessor.removeDuplicateTitle(
			contentWithoutMetadata,
			chapterTitle
		);

		// Extract headings using AnchorGenerator for TOC generation
		// We use contentWithoutDuplicateTitle to avoid duplicating the chapter title in TOC
		const headings = AnchorGenerator.parseHeadingsFromContent(contentWithoutDuplicateTitle);
		if (this.debug) {
			console.log(`[EPUB DEBUG] Headings found in ${basename(filePath)}:`, headings.length);
		}

		// Convert markdown to TelegraphNode[] (reusing the same converter and ToC options)
		const nodesRaw = convertMarkdownToTelegraphNodes(contentWithoutDuplicateTitle, {
			generateToc: options.generateToc !== false, // Default to true if not explicitly disabled
			inlineToC: options.inlineToC === true, // Default to false for EPUB, true only if explicitly enabled
			tocTitle: options.tocTitle,
			tocSeparators: options.tocSeparators !== false,
			target: "epub",
		});

		// Transform legacy list-based tables into semantic tables for EPUB
		const nodes = this.transformListTables(nodesRaw);

		// Debug summary for table detection/parsing
		this.debugLogTableSummary(filePath, nodes);

		// Optional debug: save raw TelegraphNode JSON for EPUB content,
		// similar to publish debug mode, but with .epub.json suffix for clarity.
		if (this.debug) {
			const jsonOutputPath = resolve(filePath.replace(/\.md$/i, ".epub.json"));
			try {
				writeFileSync(jsonOutputPath, JSON.stringify(nodes, null, 2), "utf-8");
				// Do not use ProgressIndicator here to keep EPUB generator decoupled from CLI UI.
			} catch {
				// Swallow debug JSON errors to avoid breaking EPUB generation.
			}
		}

		// Resolve local links (same as Telegraph publication)
		const linkResolver = new LinkResolver();
		const resolvedNodes = await this.resolveLinksInNodes(nodes, filePath, linkResolver);

		const chapterId = `chapter-${this.chapters.length + 1}`;

		this.chapters.push({
			title: chapterTitle,
			content: resolvedNodes,
			id: chapterId,
			sourcePath: resolve(filePath),
			headings: headings,
		});
	}

	/**
	 * Resolve local links in nodes (reusing LinkResolver logic)
	 */
	private async resolveLinksInNodes(
		nodes: TelegraphNode[],
		sourcePath: string,
		linkResolver: LinkResolver
	): Promise<TelegraphNode[]> {
		const resolvedNodes: TelegraphNode[] = [];

		for (const node of nodes) {
			if (node.tag === "a" && node.attrs?.href) {
				const originalHref = node.attrs.href;
				// Check if it's a local markdown-style link (not http/https/mailto/etc., not pure anchor)
				if (originalHref.startsWith("./") || originalHref.startsWith("../") || (!originalHref.startsWith("http") && !originalHref.startsWith("#"))) {
					// For EPUB, we convert local markdown links to internal chapter references.
					// Create a temporary markdown content to use findLocalLinks.
					const tempContent = `[link](${originalHref})`;
					const localLinks = LinkResolver.findLocalLinks(tempContent, sourcePath);

					if (localLinks.length > 0 && localLinks[0]) {
						const resolvedWithAnchor = localLinks[0].resolvedPath;
						const anchorIndex = resolvedWithAnchor.indexOf("#");
						const resolvedPath = anchorIndex !== -1
							? resolvedWithAnchor.substring(0, anchorIndex)
							: resolvedWithAnchor;
						const anchorSuffix = anchorIndex !== -1
							? resolvedWithAnchor.substring(anchorIndex)
							: "";

						// Prefer explicit chapter mapping when available
						const mappedHref = this.chapterPathMap.get(resolvedPath);
						if (mappedHref) {
							resolvedNodes.push({
								...node,
								attrs: {
									...node.attrs,
									href: `${mappedHref}${anchorSuffix}`,
								},
							});
							continue;
						}

						// Fallback: attempt to locate chapter by sourcePath
						const chapterIndex = this.chapters.findIndex(
							(ch) => ch.sourcePath === resolvedPath,
						);
						if (chapterIndex !== -1) {
							const htmlFile = `chapter-${chapterIndex + 1}.html${anchorSuffix}`;
							resolvedNodes.push({
								...node,
								attrs: {
									...node.attrs,
									href: htmlFile,
								},
							});
							continue;
						}
					}
				}
			}

			// Recursively process children
			if (node.children) {
				const resolvedChildren: (string | TelegraphNode)[] = [];
				for (const child of node.children) {
					if (typeof child === "string") {
						resolvedChildren.push(child);
					} else {
						const resolvedChildNodes = await this.resolveLinksInNodes([child], sourcePath, linkResolver);
						resolvedChildren.push(...resolvedChildNodes);
					}
				}
				resolvedNodes.push({
					...node,
					children: resolvedChildren,
				});
			} else {
				resolvedNodes.push(node);
			}
		}

		return resolvedNodes;
	}

	/**
	 * Rewrite local Markdown links inside a chapter's node tree for the in-memory
	 * (`addChapterFromContent`) flow, which skips the disk-based LinkResolver.
	 *
	 * Rules (relative to the chapter's own source file directory):
	 * - `http(s)://`, `//host`, `mailto:`, `tel:`, `ftp(s):`, `data:` → left unchanged.
	 * - pure in-page `#anchor` → re-slugified with `slugifyBase` to match heading ids.
	 * - local `*.md` (optionally `./`, `../`, `#anchor`) resolving to a chapter in the
	 *   build → `chapter-N.html` plus `#` + `slugifyBase(anchor)`.
	 * - local `*.md` that resolves to a file NOT in the build (excluded/unknown) → the
	 *   link is dropped and replaced by its own text (no dead href).
	 * - any other relative href (images, non-md files) → left unchanged.
	 */
	private rewriteChapterLinks(nodes: TelegraphNode[], sourcePath: string): TelegraphNode[] {
		const sourceDir = sourcePath ? dirname(sourcePath) : "";
		return this.rewriteLinkChildren(nodes, sourceDir) as TelegraphNode[];
	}

	private rewriteLinkChildren(
		children: (string | TelegraphNode)[],
		sourceDir: string,
	): (string | TelegraphNode)[] {
		const result: (string | TelegraphNode)[] = [];
		for (const child of children) {
			if (typeof child === "string") {
				result.push(child);
				continue;
			}

			if (child.tag === "a" && child.attrs?.href) {
				const decision = this.classifyLink(child.attrs.href, sourceDir);
				if (decision.kind === "degrade") {
					// Drop the dead link but keep its (recursively processed) inline text.
					result.push(...this.rewriteLinkChildren(child.children ?? [], sourceDir));
					continue;
				}
				const newChildren = child.children
					? this.rewriteLinkChildren(child.children, sourceDir)
					: child.children;
				if (decision.kind === "rewrite") {
					result.push({
						...child,
						attrs: { ...child.attrs, href: decision.href },
						children: newChildren,
					});
				} else {
					result.push({ ...child, children: newChildren });
				}
				continue;
			}

			if (child.children) {
				result.push({ ...child, children: this.rewriteLinkChildren(child.children, sourceDir) });
			} else {
				result.push(child);
			}
		}
		return result;
	}

	/**
	 * Decide how a single link href should be rewritten. See `rewriteChapterLinks`
	 * for the full rule set.
	 */
	private classifyLink(
		href: string,
		sourceDir: string,
	): { kind: "unchanged" } | { kind: "degrade" } | { kind: "rewrite"; href: string } {
		const raw = href.trim();
		if (raw.length === 0) {
			return { kind: "unchanged" };
		}

		// External / non-navigable schemes and protocol-relative URLs: untouched.
		if (/^(https?|ftps?|mailto|tel|data):/i.test(raw) || raw.startsWith("//")) {
			return { kind: "unchanged" };
		}

		// Pure in-page anchor: re-slugify so it matches the heading ids we emit.
		if (raw.startsWith("#")) {
			return { kind: "rewrite", href: `#${slugifyBase(raw.slice(1))}` };
		}

		const hashIndex = raw.indexOf("#");
		const pathPart = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
		const anchorPart = hashIndex === -1 ? "" : raw.slice(hashIndex + 1);

		// Only local Markdown links become internal chapter references.
		if (!/\.md$/i.test(pathPart)) {
			return { kind: "unchanged" };
		}

		if (!sourceDir) {
			// No source context to resolve against: avoid emitting a dead `.md` href.
			return { kind: "degrade" };
		}

		let decodedPath = pathPart;
		try {
			decodedPath = decodeURIComponent(pathPart);
		} catch {
			// Keep the raw path if it is not valid percent-encoding.
		}

		const targetAbs = resolve(sourceDir, decodedPath);
		const mappedHref = this.chapterPathMap.get(targetAbs);
		if (!mappedHref) {
			// Target file is excluded from or unknown to the build → degrade to text.
			return { kind: "degrade" };
		}

		const anchorSuffix = anchorPart ? `#${slugifyBase(anchorPart)}` : "";
		return { kind: "rewrite", href: `${mappedHref}${anchorSuffix}` };
	}

	/**
	 * Copy the cover image into `OEBPS/images/` and write a cover XHTML page.
	 * No-op when no cover is configured or the file does not exist (the caller is
	 * responsible for surfacing a warning in the latter case).
	 */
	private embedCover(oebpsDir: string): void {
		this.coverImageHref = undefined;
		if (!this.cover || !existsSync(this.cover)) {
			return;
		}
		const ext = extname(this.cover).toLowerCase();
		const imagesDir = join(oebpsDir, "images");
		mkdirSync(imagesDir, { recursive: true });
		const coverImageHref = `images/cover${ext}`;
		copyFileSync(this.cover, join(oebpsDir, coverImageHref));
		writeFileSync(join(oebpsDir, "cover.xhtml"), this.generateCoverXhtml(coverImageHref), "utf-8");
		this.coverImageHref = coverImageHref;
	}

	/**
	 * Generate the XHTML cover page that fronts the spine.
	 */
	private generateCoverXhtml(coverImageHref: string): string {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
	<meta charset="UTF-8"/>
	<title>Cover</title>
	<style type="text/css">
		html, body { margin: 0; padding: 0; }
		.cover { text-align: center; }
		.cover img { max-width: 100%; max-height: 100vh; }
	</style>
</head>
<body epub:type="cover">
	<div class="cover"><img src="${coverImageHref}" alt="${this.escapeHtml(this.title)}"/></div>
</body>
</html>`;
	}

	/**
	 * Convert TelegraphNode to HTML string
	 */
	private nodeToHtml(node: TelegraphNode): string {
		if (typeof node === "string") {
			return this.escapeHtml(node);
		}

		const tag = node.tag || "p";
		const attrs = node.attrs || {};
		const children = node.children || [];

		// Build attributes string
		const attrsString = Object.entries(attrs)
			.map(([key, value]) => `${key}="${this.escapeHtml(value)}"`)
			.join(" ");

		// Convert children to HTML
		let childrenHtml = children
			.map((child) => {
				if (typeof child === "string") {
					return this.escapeHtml(child);
				}
				return this.nodeToHtml(child);
			})
			.join("");

		// Wrap blockquote content in <code> for proper rendering in EPUB readers
		// EPUB readers don't handle CSS font changes well, so structural wrapping
		// ensures citations/Sanskrit text renders with the right font.
		if (tag === "blockquote") {
			childrenHtml = `<code>${childrenHtml}</code>`;
		}

		// Handle self-closing tags
		const selfClosingTags = ["br", "hr", "img"];
		if (selfClosingTags.includes(tag)) {
			return `<${tag}${attrsString ? ` ${attrsString}` : ""} />`;
		}

		return `<${tag}${attrsString ? ` ${attrsString}` : ""}>${childrenHtml}</${tag}>`;
	}

	/**
	 * Escape HTML special characters
	 */
	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	/**
	 * Generate EPUB file
	 */
	async generate(): Promise<void> {
		const epubDir = join(dirname(this.outputPath), `.epub-temp-${Date.now()}`);
		mkdirSync(epubDir, { recursive: true });

		try {
			// Create EPUB structure
			const metaInfDir = join(epubDir, "META-INF");
			const oebpsDir = join(epubDir, "OEBPS");
			mkdirSync(metaInfDir, { recursive: true });
			mkdirSync(oebpsDir, { recursive: true });

			// 1. mimetype (must be first, uncompressed)
			writeFileSync(join(epubDir, "mimetype"), "application/epub+zip", "utf-8");

			// 2. META-INF/container.xml
			writeFileSync(
				join(metaInfDir, "container.xml"),
				`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
	<rootfiles>
		<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
	</rootfiles>
</container>`,
				"utf-8"
			);

			// 3. Embed the cover image + cover page (before chapter HTML so the OPF
			//    manifest/spine can reference them). Missing cover files are skipped
			//    silently here — the caller validates and warns.
			this.embedCover(oebpsDir);

			// 4. Rewrite in-memory chapter links now that the full chapter map and
			//    each chapter's source path are known: cross-chapter `.md` links
			//    become `chapter-N.html#slug`, links to files outside the build
			//    degrade to plain text, external links stay untouched.
			for (const chapter of this.chapters) {
				chapter.content = this.rewriteChapterLinks(chapter.content, chapter.sourcePath);
			}

			// 5. Generate HTML chapters
			const htmlFiles: string[] = [];
			for (const chapter of this.chapters) {
				const htmlContent = this.generateChapterHtml(chapter);
				const htmlFileName = `${chapter.id}.html`;
				writeFileSync(join(oebpsDir, htmlFileName), htmlContent, "utf-8");
				htmlFiles.push(htmlFileName);
			}

			// 6. Generate CSS
			const cssContent = this.generateCss();
			writeFileSync(join(oebpsDir, "style.css"), cssContent, "utf-8");

			// 7. Generate content.opf (package document)
			const opfContent = this.generateOpf(htmlFiles);
			writeFileSync(join(oebpsDir, "content.opf"), opfContent, "utf-8");

			// 8. Generate toc.ncx (navigation)
			const ncxContent = this.generateNcx();
			writeFileSync(join(oebpsDir, "toc.ncx"), ncxContent, "utf-8");

			// 9. Create ZIP archive (using Bun's built-in ZIP support or manual ZIP creation)
			await this.createZipArchive(epubDir, this.outputPath);

			// Cleanup temp directory (unless in debug mode)
			if (this.debug) {
				console.log(`🔧 Debug mode: Temporary files kept at: ${epubDir}`);
				console.log(`   You can inspect the generated EPUB structure and HTML files there.`);
			} else {
				await this.cleanupDirectory(epubDir);
			}
		} catch (error) {
			// Cleanup on error (unless in debug mode)
			if (this.debug) {
				console.log(`🔧 Debug mode: Temporary files kept at: ${epubDir} (due to error)`);
				console.log(`   You can inspect the partial EPUB structure to debug the issue.`);
			} else {
				await this.cleanupDirectory(epubDir);
			}
			throw error;
		}
	}

	/**
	 * Generate HTML for a chapter
	 */
	private generateChapterHtml(chapter: { title: string; content: TelegraphNode[]; id: string }): string {
		const contentHtml = chapter.content.map((node) => this.nodeToHtml(node)).join("\n");

		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
	<meta charset="UTF-8"/>
	<title>${this.escapeHtml(chapter.title)}</title>
	<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
	<h1 id="${chapter.id}">${this.escapeHtml(chapter.title)}</h1>
	${contentHtml}
</body>
</html>`;
	}

	/**
	 * Generate CSS styles
	 */
	private generateCss(): string {
		return `/* ===================== */
/* Font Family Settings  */
/* ===================== */

body {
	font-family: Georgia, serif;
	line-height: 1.6;
	margin: 1em;
	padding: 0;
}

/* ===================== */
/* Heading Styles        */
/* ===================== */

h1 {
	font-size: 2em;
	margin-top: 1em;
	margin-bottom: 0.5em;
}

h2, h3, h4 {
	margin-top: 1em;
	margin-bottom: 0.5em;
}

h3 {
	font-size: 1.5em;
}

h4 {
	font-size: 1.2em;
}

/* ===================== */
/* Paragraph & Lists     */
/* ===================== */

p {
	margin: 1em 0;
	text-align: justify;
}

ul, ol {
	margin: 1em 0;
	padding-left: 2em;
}

li {
	margin: 0.5em 0;
}

/* ===================== */
/* Links & Typography    */
/* ===================== */

a {
	color: #0066cc;
	text-decoration: none;
}

a:hover {
	text-decoration: underline;
}

hr {
	border: none;
	border-top: 1px solid #ccc;
	margin: 2em 0;
}

strong {
	font-weight: bold;
}

em {
	font-style: italic;
}

/* ===================== */
/* Code & Sanskrit Text  */
/* ===================== */

/* Inline code for Sanskrit text with diacritics (IAST)
   Uses serif fonts with good diacritic support.
   Styled as italic for visual distinction from body text. */
code {
	font-family: "DejaVu Serif", "Liberation Serif", Georgia, serif;
	font-style: italic;
	color: #1a3a52;
	background-color: transparent;
	padding: 0;
	border-radius: 0;
	letter-spacing: 0.02em;
}

/* Code blocks for Sanskrit text with diacritics (IAST)
   Styled same as inline code but with left border for visual distinction.
   Use triple backticks for text blocks in Markdown. */
pre {
	font-family: "DejaVu Serif", "Liberation Serif", Georgia, serif;
	font-style: italic;
	color: #1a3a52;
	background-color: transparent;
	padding: 1em;
	border-left: 4px solid #1a3a52;
	margin: 1em 0;
	overflow-x: auto;
	letter-spacing: 0.02em;
}

pre code {
	/* Code inside pre blocks inherits pre styling */
	font-family: inherit;
	font-style: inherit;
	color: inherit;
	background-color: transparent;
	padding: 0;
	letter-spacing: inherit;
}

/* ===================== */
/* Blockquotes           */
/* ===================== */

blockquote {
	border-left: 4px solid #ccc;
	margin: 1em 0;
	padding-left: 1em;
	color: #666;
}

/* Code wrapper inside blockquotes: inherit blockquote layout,
   display as block so line breaks work properly in EPUB readers */
blockquote code {
	display: block;
	background-color: transparent;
	padding: 0;
}`;
	}

	/**
	 * Generate content.opf (package document)
	 */
	private generateOpf(htmlFiles: string[]): string {
		const now = new Date().toISOString();
		const hasCover = this.coverImageHref !== undefined;

		let manifestItems = htmlFiles
			.map(
				(file, index) =>
					`		<item id="chapter-${index + 1}" href="${file}" media-type="application/xhtml+xml"/>`
			)
			.join("\n");

		// Add the cover image + cover page to the manifest when a cover was embedded.
		if (hasCover) {
			manifestItems = `		<item id="cover-image" href="${this.coverImageHref}" media-type="${this.getCoverMediaType()}" properties="cover-image"/>
		<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
${manifestItems}`;
		}

		let spineItems = htmlFiles
			.map((_, index) => `		<itemref idref="chapter-${index + 1}"/>`)
			.join("\n");

		// The cover page fronts the spine so it is the first thing a reader sees.
		if (hasCover) {
			spineItems = `		<itemref idref="cover" linear="yes"/>\n${spineItems}`;
		}

		// `<meta name="cover">` is the OPF2 convention many readers still rely on.
		const coverMeta = hasCover ? `\n		<meta name="cover" content="cover-image"/>` : "";

		const guideSection = hasCover
			? `	<guide>
		<reference href="cover.xhtml" type="cover" title="Cover"/>
	</guide>
`
			: "";

		return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
		<dc:title>${this.escapeHtml(this.title)}</dc:title>
		<dc:creator>${this.escapeHtml(this.author)}</dc:creator>
		<dc:language>${this.language}</dc:language>
		<dc:identifier id="book-id">${this.identifier}</dc:identifier>
		<meta property="dcterms:modified">${now}</meta>${coverMeta}
	</metadata>
	<manifest>
		<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
		<item id="css" href="style.css" media-type="text/css"/>
${manifestItems}
	</manifest>
	<spine toc="ncx">
${spineItems}
	</spine>
${guideSection}</package>`;
	}

	/**
	 * Get media type for cover image
	 */
	private getCoverMediaType(): string {
		if (!this.cover) return "image/jpeg"; // default

		const ext = extname(this.cover).toLowerCase();
		switch (ext) {
			case ".jpg":
			case ".jpeg":
				return "image/jpeg";
			case ".png":
				return "image/png";
			default:
				return "image/jpeg"; // fallback
		}
	}

	/**
	 * Generate toc.ncx (navigation).
	 *
	 * When a nav tree is set (`setNavTree`), the NCX mirrors the manuscript folder
	 * hierarchy (parts -> chapters) with each chapter's internal headings nested
	 * beneath it. Otherwise it falls back to the flat chapter list.
	 */
	private generateNcx(): string {
		const counter = { playOrder: 1 };
		const navPointsXml = this.navTree && this.navTree.length > 0
			? this.generateNcxFromNavTree(counter)
			: this.generateNcxFromChapters(counter);

		return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
	<head>
		<meta name="dtb:uid" content="${this.identifier}"/>
		<meta name="dtb:depth" content="4"/>
		<meta name="dtb:totalPageCount" content="0"/>
		<meta name="dtb:maxPageNumber" content="0"/>
	</head>
	<docTitle>
		<text>${this.escapeHtml(this.title)}</text>
	</docTitle>
	<navMap>
${navPointsXml}
	</navMap>
</ncx>`;
	}

	/**
	 * Flat NCX: one top-level navPoint per chapter with its internal headings nested.
	 */
	private generateNcxFromChapters(counter: { playOrder: number }): string {
		let navPointsXml = "";
		for (const chapter of this.chapters) {
			const order = counter.playOrder++;
			navPointsXml += `		<navPoint id="nav-${order}" playOrder="${order}">
			<navLabel>
				<text>${this.escapeHtml(chapter.title)}</text>
			</navLabel>
			<content src="${chapter.id}.html"/>`;
			navPointsXml += this.serializeChapterHeadings(chapter, "\t\t\t", counter);
			navPointsXml += `\n		</navPoint>\n`;
		}
		return navPointsXml;
	}

	/**
	 * Nested NCX from the manuscript folder tree (parts -> chapters). Folder
	 * navPoints point at their first descendant chapter (NCX requires a content src).
	 */
	private generateNcxFromNavTree(counter: { playOrder: number }): string {
		const chapterById = new Map(this.chapters.map((chapter) => [chapter.id, chapter] as const));

		const firstSrc = (node: EpubNavPoint): string => {
			if (node.chapterId) {
				return `${node.chapterId}.html`;
			}
			for (const child of node.children) {
				const src = firstSrc(child);
				if (src) {
					return src;
				}
			}
			return "";
		};

		const serialize = (node: EpubNavPoint, indent: string): string => {
			const order = counter.playOrder++;
			const src = node.chapterId ? `${node.chapterId}.html` : firstSrc(node);
			let xml = `${indent}<navPoint id="nav-${order}" playOrder="${order}">
${indent}	<navLabel>
${indent}		<text>${this.escapeHtml(node.title)}</text>
${indent}	</navLabel>
${indent}	<content src="${src}"/>`;

			if (node.chapterId) {
				const chapter = chapterById.get(node.chapterId);
				if (chapter) {
					xml += this.serializeChapterHeadings(chapter, indent + "\t", counter);
				}
			} else {
				for (const child of node.children) {
					xml += `\n${serialize(child, indent + "\t")}`;
				}
			}

			xml += `\n${indent}</navPoint>`;
			return xml;
		};

		return this.navTree!.map((node) => serialize(node, "\t\t")).join("\n");
	}

	/**
	 * Build the nested navPoints for a chapter's internal headings and serialize
	 * them, advancing the shared playOrder counter. Returns "" when the chapter
	 * has no headings.
	 */
	private serializeChapterHeadings(
		chapter: { title: string; id: string; headings: HeadingInfo[] },
		baseIndent: string,
		counter: { playOrder: number },
	): string {
		if (!chapter.headings || chapter.headings.length === 0) {
			return "";
		}

		interface NavNode {
			label: string;
			src: string;
			children: NavNode[];
		}

		// Root of the current chapter's tree (level 0). Its children are serialized.
		const root: NavNode = { label: chapter.title, src: `${chapter.id}.html`, children: [] };
		const stack: { node: NavNode; level: number }[] = [{ node: root, level: 0 }];

		for (const heading of chapter.headings) {
			while (stack.length > 1 && stack[stack.length - 1]!.level >= heading.level) {
				stack.pop();
			}
			const parent = stack[stack.length - 1]!;
			const anchor = AnchorGenerator.generateAnchor(heading);
			const newNode: NavNode = {
				label: heading.textForAnchor,
				src: `${chapter.id}.html#${anchor}`,
				children: [],
			};
			parent.node.children.push(newNode);
			stack.push({ node: newNode, level: heading.level });
		}

		const serializeNodes = (nodes: NavNode[], indent: string): string => {
			let result = "";
			for (const node of nodes) {
				const order = counter.playOrder++;
				result += `\n${indent}<navPoint id="nav-${order}" playOrder="${order}">
${indent}	<navLabel>
${indent}		<text>${this.escapeHtml(node.label)}</text>
${indent}	</navLabel>
${indent}	<content src="${node.src}"/>`;
				if (node.children.length > 0) {
					result += serializeNodes(node.children, indent + "\t");
				}
				result += `\n${indent}</navPoint>`;
			}
			return result;
		};

		return serializeNodes(root.children, baseIndent);
	}

	/**
	 * Create ZIP archive from directory
	 * Uses manual ZIP creation without external dependencies
	 */
	private async createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
		// Use Bun's shell `zip` fast path when available (and not forced to manual).
		// The Theia backend runs under Node, where Bun is undefined, so it falls
		// back to the built-in ZIP writer below.
		const bunShell = (globalThis as { Bun?: { $?: (strings: TemplateStringsArray, ...values: unknown[]) => { quiet(): Promise<{ exitCode: number }> } } }).Bun?.$;
		if (this.zipStrategy !== "manual" && bunShell) {
			try {
				const result = await bunShell`cd ${sourceDir} && zip -r ${outputPath} . -x "*.DS_Store"`.quiet();
				if (result.exitCode === 0) {
					return;
				}
			} catch {
				// Fall through to manual ZIP creation
			}
		}

		// Manual ZIP creation using standard ZIP format (pure Node, no dependencies)
		await this.createZipManually(sourceDir, outputPath);
	}

	/**
	 * Create ZIP archive manually without external dependencies
	 */
	private async createZipManually(sourceDir: string, outputPath: string): Promise<void> {
		// Collect all files recursively
		const files: Array<{ content: Buffer; zipPath: string }> = [];

		const collectFiles = async (dir: string, baseDir: string): Promise<void> => {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const relativePath = relative(baseDir, fullPath);

				if (entry.isDirectory()) {
					await collectFiles(fullPath, baseDir);
				} else {
					const content = await readFile(fullPath);
					files.push({
						content,
						zipPath: relativePath.replace(/\\/g, "/"),
					});
				}
			}
		};

		await collectFiles(sourceDir, sourceDir);

		// EPUB requires the `mimetype` entry to be the first file in the archive
		// (stored uncompressed, which the manual writer always does).
		files.sort((left, right) => {
			if (left.zipPath === "mimetype") return -1;
			if (right.zipPath === "mimetype") return 1;
			return 0;
		});

		// Write ZIP file
		const writeStream = createWriteStream(outputPath);
		const centralDirBuffers: Buffer[] = [];
		let currentOffset = 0;

		// Write each file with local header
		for (const file of files) {
			const fileNameBytes = Buffer.from(file.zipPath, "utf-8");
			const crc32 = this.calculateCrc32(file.content);
			const fileSize = file.content.length;

			// Write local file header
			const localHeader = Buffer.alloc(30 + fileNameBytes.length);
			localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
			localHeader.writeUInt16LE(20, 4); // Version needed to extract
			localHeader.writeUInt16LE(0, 6); // General purpose bit flag
			localHeader.writeUInt16LE(0, 8); // Compression method (store)
			localHeader.writeUInt16LE(0, 10); // Last mod time
			localHeader.writeUInt16LE(0, 12); // Last mod date
			localHeader.writeUInt32LE(crc32, 14); // CRC-32
			localHeader.writeUInt32LE(fileSize, 18); // Compressed size
			localHeader.writeUInt32LE(fileSize, 22); // Uncompressed size
			localHeader.writeUInt16LE(fileNameBytes.length, 26); // File name length
			localHeader.writeUInt16LE(0, 28); // Extra field length
			fileNameBytes.copy(localHeader, 30);

			writeStream.write(localHeader);
			writeStream.write(file.content);

			// Create central directory entry
			const centralEntry = Buffer.alloc(46 + fileNameBytes.length);
			centralEntry.writeUInt32LE(0x02014b50, 0); // Central file header signature
			centralEntry.writeUInt16LE(20, 4); // Version made by
			centralEntry.writeUInt16LE(20, 6); // Version needed
			centralEntry.writeUInt16LE(0, 8); // General purpose bit flag
			centralEntry.writeUInt16LE(0, 10); // Compression method
			centralEntry.writeUInt16LE(0, 12); // Last mod time
			centralEntry.writeUInt16LE(0, 14); // Last mod date
			centralEntry.writeUInt32LE(crc32, 16); // CRC-32
			centralEntry.writeUInt32LE(fileSize, 20); // Compressed size
			centralEntry.writeUInt32LE(fileSize, 24); // Uncompressed size
			centralEntry.writeUInt16LE(fileNameBytes.length, 28); // File name length
			centralEntry.writeUInt16LE(0, 30); // Extra field length
			centralEntry.writeUInt16LE(0, 32); // File comment length
			centralEntry.writeUInt16LE(0, 34); // Disk number start
			centralEntry.writeUInt16LE(0, 36); // Internal file attributes
			centralEntry.writeUInt32LE(0, 38); // External file attributes
			centralEntry.writeUInt32LE(currentOffset, 42); // Relative offset of local header
			fileNameBytes.copy(centralEntry, 46);

			centralDirBuffers.push(centralEntry);
			currentOffset += localHeader.length + fileSize;
		}

		// Write central directory
		for (const buf of centralDirBuffers) {
			writeStream.write(buf);
		}

		// Write end of central directory record
		const centralDirSize = centralDirBuffers.reduce((sum, buf) => sum + buf.length, 0);
		const endRecord = Buffer.alloc(22);
		endRecord.writeUInt32LE(0x06054b50, 0); // End of central directory signature
		endRecord.writeUInt16LE(0, 4); // Number of this disk
		endRecord.writeUInt16LE(0, 6); // Disk with start of central directory
		endRecord.writeUInt16LE(files.length, 8); // Number of central directory records on this disk
		endRecord.writeUInt16LE(files.length, 10); // Total number of central directory records
		endRecord.writeUInt32LE(centralDirSize, 12); // Size of central directory
		endRecord.writeUInt32LE(currentOffset, 16); // Offset of start of central directory
		endRecord.writeUInt16LE(0, 20); // ZIP file comment length

		writeStream.write(endRecord);
		writeStream.end();

		// Wait for stream to finish
		await new Promise<void>((resolve, reject) => {
			writeStream.on("finish", resolve);
			writeStream.on("error", reject);
		});
	}

	/**
	 * Calculate CRC-32 checksum
	 */
	private calculateCrc32(buffer: Buffer): number {
		let crc = 0xffffffff;
		const crcTable: number[] = Array(256).fill(0);

		// Generate CRC table
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let j = 0; j < 8; j++) {
				c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			crcTable[i] = c;
		}

		// Calculate CRC
		for (let i = 0; i < buffer.length; i++) {
			const byte = buffer[i];
			const tableIndex = ((crc ^ (byte ?? 0)) & 0xff);
			const tableValue = crcTable[tableIndex];
			if (tableValue !== undefined) {
				crc = tableValue ^ (crc >>> 8);
			}
		}

		return (crc ^ 0xffffffff) >>> 0;
	}

	/**
	 * Cleanup temporary directory
	 */
	private async cleanupDirectory(dir: string): Promise<void> {
		rmSync(dir, { recursive: true, force: true });
	}
}
