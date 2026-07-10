/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted and trimmed
 * to the self-contained EPUB export closure for AI Focused Editor.
 */
import type { TelegraphNode } from "./telegraph-node"; // Import TelegraphNode interface
import { AnchorGenerator, type HeadingInfo } from "./AnchorGenerator"; // Import unified anchor generator

/**
 * Validates cleaned content to ensure it does not contain unsupported syntax, like raw HTML tags.
 * @param content The content string (expected to be Markdown, potentially with HTML, which we want to disallow).
 * @throws Error if unsupported syntax (HTML tags) is found.
 */
export function validateCleanedContent(content: string): void {
	// This regex specifically looks for HTML-like tags, not Markdown syntax.
	// It should detect things like <p>, <div>, <span>, etc.
	const htmlTagRegex = /<\/?\w+\b[^>]*>/;
	if (htmlTagRegex.test(content)) {
		throw new Error(
			"Content contains unsupported HTML tags. Only Markdown formatting is allowed.",
		);
	}
}

/**
 * Extracts the first heading from Markdown content and returns it as a title,
 * along with the remaining content.
 * @param markdown The raw Markdown content.
 * @returns An object containing the extracted title (or null) and the modified content.
 */
export function extractTitleAndContent(markdown: string): {
	title: string | null;
	content: string;
} {
	const lines = markdown.split(/\r?\n/);
	let title: string | null = null;
	let contentStartIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() || "";
		if (line === "") {
			contentStartIndex++;
			continue; // Skip empty lines at the beginning
		}

		const headingMatch = line.match(/^(#+)\s*(.*)/);
		// Check if the first non-empty line is a heading or bold/italic text that looks like a title
		const boldItalicMatch = line.match(
			/^(?:\*{2}|__)(.*?)(?:\*{2}|__)$|^\*(.*?)\*$|^_(.*?)_$/,
		);

		if (
			headingMatch &&
			headingMatch.length > 2 &&
			headingMatch[2] !== undefined
		) {
			const headingText = headingMatch[2];
			title = headingText.trim();
			contentStartIndex = i + 1;
			break;
		} else if (boldItalicMatch) {
			// If it's a bold/italic line, consider it a title if no heading was found yet
			title = (
				boldItalicMatch[1] ||
				boldItalicMatch[2] ||
				boldItalicMatch[3] ||
				""
			).trim();
			contentStartIndex = i + 1;
			break;
		}
		// If the first non-empty line is not a recognized title format, treat entire content as is
		break;
	}

	const remainingContent = lines.slice(contentStartIndex).join("\n");

	return { title, content: remainingContent };
}

/**
 * Parses a Markdown table and converts it to a nested list structure.
 * @param tableLines Array of lines that form the table
 * @returns TelegraphNode representing the nested list structure
 */
function parseTable(tableLines: string[], asHtmlTable: boolean = false): TelegraphNode {
	if (tableLines.length < 3) {
		// Not a valid table, return as paragraphs
		return { tag: "p", children: [tableLines.join("\n")] };
	}

	// Parse header row
	const headerLine = tableLines[0];
	if (!headerLine) {
		return { tag: "p", children: [tableLines.join("\n")] };
	}
	// Split by | but keep empty cells, then remove first and last empty cells
	const allHeaders = headerLine.split("|").map((cell) => cell.trim());
	const headers = allHeaders.slice(1, -1).filter((cell) => cell !== "");

	// Skip separator line (tableLines[1])

	// Parse data rows
	const dataRows = tableLines.slice(2);

	if (asHtmlTable) {
		// EPUB mode: build a semantic HTML-like table structure
		const headerCells: TelegraphNode[] = headers.map((header) => ({
			tag: "th",
			children: processInlineMarkdown(header),
		}));

		const bodyRows: TelegraphNode[] = [];

		dataRows.forEach((row) => {
			const allCells = row.split("|").map((cell) => cell.trim());
			const cells = allCells.slice(1, -1);
			if (cells.length === 0) return;

			const cellNodes: TelegraphNode[] = [];
			const numColumns = headers.length;

			for (let i = 0; i < numColumns; i++) {
				const value = cells[i] || "";
				cellNodes.push({
					tag: "td",
					children: processInlineMarkdown(value),
				});
			}

			bodyRows.push({
				tag: "tr",
				children: cellNodes,
			});
		});

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

	// Default (Telegraph) mode: convert table into nested ordered list
	const listItems: TelegraphNode[] = [];

	dataRows.forEach((row, index) => {
		// Split by | but keep empty cells (don't filter them out)
		const allCells = row.split("|").map((cell) => cell.trim());
		// Remove first and last empty cells (they're from leading/trailing |)
		const cells = allCells.slice(1, -1);

		if (cells.length === 0) return; // Skip empty rows

		// Create nested list for this row
		const nestedItems: TelegraphNode[] = [];

		// Use the number of headers as the reference
		const numColumns = headers.length;

		for (let i = 0; i < numColumns; i++) {
			const header = headers[i] || `Колонка ${i + 1}`;
			const value = cells[i] || "";

			// Preserve inline formatting (links, bold, etc.) inside table values
			const headerParts = processInlineMarkdown(header);
			const valueParts = processInlineMarkdown(value);
			const combinedChildren: (string | TelegraphNode)[] = [
				...headerParts,
				": ",
				...valueParts,
			];

			nestedItems.push({
				tag: "li",
				children: combinedChildren,
			});
		}

		// Create the main list item with number and nested list
		listItems.push({
			tag: "li",
			children: [
				`${index + 1}`,
				{
					tag: "ul",
					children: nestedItems,
				},
			],
		});
	});

	return {
		tag: "ol",
		children: listItems,
	};
}

/**
 * Creates children nodes for ToC links that handle formatting but prevent nested links
 * @param heading The heading object with text and display information
 * @returns Array of TelegraphNode children for the ToC link
 */
function createTocChildren(heading: { level: number; text: string; displayText: string; textForAnchor: string }): (string | TelegraphNode)[] {
	// Check if this is a heading-link (e.g., "## [Link Text](./file.md)")
	const linkInHeadingMatch = heading.text.match(/^\[(.*?)\]\((.*?)\)$/);
	if (linkInHeadingMatch) {
		// For heading-links, use only the plain text to avoid nested links
		return [heading.textForAnchor];
	}
	
	// For normal headings with formatting, process inline Markdown to preserve bold, italic, etc.
	return processInlineMarkdown(heading.displayText);
}

/**
 * Creates children nodes for ToC links using HeadingInfo from AnchorGenerator.
 * Handles heading-links by extracting only the text to avoid nested link elements.
 * @param headingInfo The HeadingInfo object from AnchorGenerator.
 * @returns Array of TelegraphNode elements for the link content.
 */
function createTocChildrenFromHeadingInfo(headingInfo: HeadingInfo): (string | TelegraphNode)[] {
	// Check if this is a heading-link using metadata
	if (headingInfo.metadata.hasLink && headingInfo.linkInfo) {
		// For heading-links, use only the plain text to avoid nested links
		return [headingInfo.linkInfo.text];
	}
	
	// For normal headings with formatting, process inline Markdown to preserve bold, italic, etc.
	return processInlineMarkdown(headingInfo.displayText);
}

/**
 * Generates a Table of Contents (ToC) as an aside element from Markdown content.
 * Only generates ToC if there are 2 or more headings in the document.
 * Uses the same heading processing logic as the main converter for consistency.
 * @param markdown The raw Markdown content to scan for headings.
 * @returns TelegraphNode for aside element with ToC, or null if insufficient headings.
 */
function generateTocAside(markdown: string, tocTitle: string = ''): TelegraphNode | null {
	const headings: { level: number; text: string; displayText: string; textForAnchor: string }[] = [];
	const lines = markdown.split(/\r?\n/);

	// 1. Scan for all headings using the same regex as main converter
	for (const line of lines) {
		const headingMatch = line.match(/^(#+)\s+(.*)/);
		if (headingMatch?.[1] && headingMatch[2] !== undefined) {
			const level = headingMatch[1].length;
			const originalText = headingMatch[2].trim();
			let textForAnchor = originalText;
			
			// NEW: Check if the heading text is a Markdown link
			const linkInHeadingMatch = originalText.match(/^\[(.*?)\]\((.*?)\)$/);
			if (linkInHeadingMatch) {
				// If it's a link, use only its text part for the anchor
				textForAnchor = linkInHeadingMatch[1] || '';
			}

			let displayText = originalText;

			// 2. Apply the same heading strategy logic as main converter
			switch (level) {
				case 1:
				case 2:
				case 3:
				case 4:
					displayText = originalText;
					break;
							case 5:
				displayText = `> ${originalText}`;
				textForAnchor = linkInHeadingMatch ? `> ${linkInHeadingMatch[1]}` : `> ${originalText}`;
				break;
			case 6:
				displayText = `>> ${originalText}`;
				textForAnchor = linkInHeadingMatch ? `>> ${linkInHeadingMatch[1]}` : `>> ${originalText}`;
				break;
			default:
				// Handle edge case: levels > 6
				displayText = `>>> ${originalText}`;
				textForAnchor = linkInHeadingMatch ? `>>> ${linkInHeadingMatch[1]}` : `>>> ${originalText}`;
				break;
			}

			headings.push({ level, text: originalText, displayText, textForAnchor });
		}
	}

	// 3. Check if ToC should be generated (2+ headings required)
	if (headings.length < 2) {
		return null;
	}

	// 4. Build ToC structure as list items
	const listItems: TelegraphNode[] = [];
	for (const heading of headings) {
		// IMPORTANT: Use textForAnchor for anchor generation to handle link headings properly
		// Based on empirical research: remove only < and > characters, replace spaces with hyphens
		const anchor = heading.textForAnchor
			.trim()
			.replace(/[<]/g, '') // 1. Remove < characters only (preserve > for H5/H6 prefixes)
			.replace(/ /g, '-');  // 2. Replace spaces with hyphens
		
		const linkNode: TelegraphNode = {
			tag: 'a',
			attrs: { href: `#${anchor}` },
			children: createTocChildren(heading)
		};
		
		listItems.push({
			tag: 'li',
			children: [linkNode],
		});
	}

	// 5. Return aside element with optional heading and unordered list
	const children: any[] = [];
	
	// Add heading only if tocTitle is provided and not empty
	if (tocTitle && tocTitle.trim()) {
		children.push({
			tag: 'h3',
			children: [tocTitle]
		});
	}
	
	// Always add the list
	children.push({
		tag: 'ul',
		children: listItems
	});
	
	return {
		tag: 'aside',
		children
	};
}

/**
 * Generates a Table of Contents (ToC) using the unified AnchorGenerator.
 * This ensures 100% consistency between TOC anchors and link validation anchors.
 * Only generates ToC if there are 2 or more headings in the document.
 * @param markdown The raw Markdown content to scan for headings.
 * @returns TelegraphNode for aside element with ToC, or null if insufficient headings.
 */
function generateTocAsideWithAnchorGenerator(markdown: string, tocTitle: string = ''): TelegraphNode | null {
	// Use AnchorGenerator to parse headings with unified logic
	const headings = AnchorGenerator.parseHeadingsFromContent(markdown);
	
	// Check if ToC should be generated (2+ headings required)
	if (headings.length < 2) {
		return null;
	}

	// Build ToC structure as list items
	const listItems: TelegraphNode[] = [];
	for (const headingInfo of headings) {
		// Generate anchor using unified algorithm
		const anchor = AnchorGenerator.generateAnchor(headingInfo);
		
		const linkNode: TelegraphNode = {
			tag: 'a',
			attrs: { href: `#${anchor}` },
			children: createTocChildrenFromHeadingInfo(headingInfo)
		};
		
		listItems.push({
			tag: 'li',
			children: [linkNode],
		});
	}

	// Return aside element with optional heading and unordered list
	const children: any[] = [];
	
	// Add heading only if tocTitle is provided and not empty
	if (tocTitle && tocTitle.trim()) {
		children.push({
			tag: 'h3',
			children: [tocTitle]
		});
	}
	
	// Always add the list
	children.push({
		tag: 'ul',
		children: listItems
	});
	
	return {
		tag: 'aside',
		children
	};
}

/**
 * Converts Markdown content directly into an array of TelegraphNode objects.
 * This function replaces the need for an intermediate HTML conversion step and 'mrkdwny' library.
 * It directly parses Markdown elements into the structure expected by the Telegra.ph API.
 * @param markdown The raw Markdown content.
 * @returns An array of TelegraphNode objects representing the parsed content.
 */
export function convertMarkdownToTelegraphNodes(
	markdown: string,
	options: {
		generateToc?: boolean;
		inlineToC?: boolean;
		tocTitle?: string;
		tocSeparators?: boolean;
		/**
		 * Target rendering environment:
		 * - "telegraph" (default) – optimize for Telegra.ph API (no tables)
		 * - "epub" – allow richer structures like <table>
		 * - "svg" – simplified for SVG image generation
		 */
		target?: "telegraph" | "epub" | "svg";
	} = {},
): TelegraphNode[] {
	const { generateToc = true, inlineToC = true, tocTitle, tocSeparators = true, target = "telegraph" } = options;

	const nodes: TelegraphNode[] = [];
	let currentParagraphLines: string[] = [];

	const flushParagraph = () => {
		if (currentParagraphLines.length === 0) {
			return;
		}

		// Treat consecutive non-empty lines as a single paragraph block
		// and preserve single line breaks as '\n' within the paragraph.
		const paragraphContent = currentParagraphLines.join("\n");

		if (paragraphContent.trim().length === 0) {
			currentParagraphLines = [];
			return;
		}

		nodes.push({ tag: "p", children: processInlineMarkdown(paragraphContent) });

		currentParagraphLines = [];
	};
	
	// Generate and add Table of Contents if enabled and there are 2+ headings
	// Note: inlineToC controls whether ToC is rendered inline in the content
	// generateToc controls whether ToC generation should be attempted at all
	if (generateToc && inlineToC) {
		// Feature flag: Use unified AnchorGenerator for consistent anchor generation
		const USE_UNIFIED_ANCHORS = process.env.USE_UNIFIED_ANCHORS === 'true' || 
									process.env.NODE_ENV !== 'production';
		
		const tocAside = USE_UNIFIED_ANCHORS 
			? generateTocAsideWithAnchorGenerator(markdown, tocTitle)
			: generateTocAside(markdown, tocTitle);
			
		if (tocAside) {
			// Add HR before TOC (if separators enabled)
			if (tocSeparators) {
				nodes.push({ tag: 'hr' });
			}
			
			// Extract TOC elements from aside and add them separately for better Telegram compatibility
			if (tocAside.children) {
				for (const child of tocAside.children) {
					if (typeof child !== 'string') {
						nodes.push(child);
					}
				}
			}
			
			// Add HR after TOC (if separators enabled)
			if (tocSeparators) {
				nodes.push({ tag: 'hr' });
			}
		}
	}
	
	const lines = markdown.split(/\r?\n/);

	let inCodeBlock = false;
	let codeBlockContent: string[] = [];

	// Nested list support: stack-based approach
	// Each stack item contains: { tag: "ul"|"ol", items: TelegraphNode[], indent: number }
	type ListStackItem = { tag: "ul" | "ol"; items: TelegraphNode[]; indent: number };
	let listStack: ListStackItem[] = [];
	
	// Helper to get indentation level (number of leading spaces/tabs)
	const getIndentLevel = (line: string): number => {
		const match = line.match(/^(\s*)/);
		if (!match || !match[1]) return 0;
		// Normalize: treat 1 tab as 2 spaces, count spaces
		return match[1].replace(/\t/g, '  ').length;
	};
	
	// Helper to flush the list stack into a single nested structure
	const flushListStack = (): TelegraphNode | null => {
		if (listStack.length === 0) return null;
		
		// Build from bottom to top
		while (listStack.length > 1) {
			const child = listStack.pop();
			if (!child) break;
			
			const parent = listStack[listStack.length - 1];
			if (!parent) break;
			
			const childList: TelegraphNode = { tag: child.tag, children: child.items };
			
			// Append child list to the last item of parent
			if (parent.items.length > 0) {
				const lastItem = parent.items[parent.items.length - 1];
				if (lastItem && lastItem.children) {
					lastItem.children.push(childList);
				}
			}
		}
		
		const root = listStack.pop();
		if (!root) return null;
		return { tag: root.tag, children: root.items };
	};

	let inBlockquote = false;
	let blockquoteContent: string[] = [];

	let inTable = false;
	let tableLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] || "";

		// Handle code blocks first (they have highest priority)
		if (line.startsWith("```")) {
			if (inCodeBlock) {
				// End of code block
				// Close any open blocks first
				flushParagraph();
				if (inTable) {
					nodes.push(parseTable(tableLines, target === "epub"));
					inTable = false;
					tableLines = [];
				}
				if (listStack.length > 0) {
					const closedList = flushListStack();
					if (closedList) nodes.push(closedList);
				}
				if (inBlockquote) {
					nodes.push({
						tag: "blockquote",
						children: processInlineMarkdown(blockquoteContent.join("\n")),
					});
					inBlockquote = false;
					blockquoteContent = [];
				}

				nodes.push({
					tag: "pre",
					children: [
						{ tag: "code", children: [codeBlockContent.join("\n").trimEnd()] },
					],
				});
				codeBlockContent = [];
				inCodeBlock = false;
			} else {
				// Start of code block
				// Close any open blocks first
				flushParagraph();
				if (inTable) {
					nodes.push(parseTable(tableLines, target === "epub"));
					inTable = false;
					tableLines = [];
				}
				if (listStack.length > 0) {
					const closedList = flushListStack();
					if (closedList) nodes.push(closedList);
				}
				if (inBlockquote) {
					nodes.push({
						tag: "blockquote",
						children: processInlineMarkdown(blockquoteContent.join("\n")),
					});
					inBlockquote = false;
					blockquoteContent = [];
				}

				inCodeBlock = true;
			}
			continue;
		}

		if (inCodeBlock) {
			codeBlockContent.push(line);
			continue;
		}

		// Handle table detection and parsing
		const isTableLine = line.includes("|") && line.trim() !== "";
		// Separator must include at least one pipe to avoid catching horizontal rules like '---'
		const isTableSeparator =
			line.includes("|") && /^\s*\|?[\s\-|:]+\|?\s*$/.test(line);

		if (isTableLine || isTableSeparator) {
			if (!inTable) {
				// Close any open blocks first
				flushParagraph();
				if (listStack.length > 0) {
					const closedList = flushListStack();
					if (closedList) nodes.push(closedList);
				}
				if (inBlockquote) {
					nodes.push({
						tag: "blockquote",
						children: processInlineMarkdown(blockquoteContent.join("\n")),
					});
					inBlockquote = false;
					blockquoteContent = [];
				}

				inTable = true;
				tableLines = [];
			}
			tableLines.push(line);
			continue;
		} else if (inTable) {
			// End of table
			flushParagraph();
			nodes.push(parseTable(tableLines, target === "epub"));
			inTable = false;
			tableLines = [];
			// Continue processing current line
		}

		// Handle blockquotes
		if (line.startsWith(">")) {
			if (!inBlockquote) {
				// If previously in a list, close it first
				flushParagraph();
				if (listStack.length > 0) {
					const closedList = flushListStack();
					if (closedList) nodes.push(closedList);
				}
				inBlockquote = true;
				blockquoteContent = [];
			}
			blockquoteContent.push(line.substring(1).trimStart()); // Remove '>' and leading space
			continue;
		} else if (inBlockquote) {
			// If not a blockquote line, but was in blockquote, close it
			flushParagraph();
			nodes.push({
				tag: "blockquote",
				children: processInlineMarkdown(blockquoteContent.join("\n")),
			});
			inBlockquote = false;
			blockquoteContent = [];
			// Process current line as a new element
		}

		// Handle headings (MOVED UP - before lists to prevent numbered headings from being parsed as list items)
		const headingMatch = line.match(/^(#+)\s*(.*)/);
		if (headingMatch?.[1] && headingMatch[2] !== undefined) {
			// Close any open blocks before adding a heading
			flushParagraph();
			if (listStack.length > 0) {
				const closedList = flushListStack();
				if (closedList) nodes.push(closedList);
			}
			if (inBlockquote) {
				nodes.push({
					tag: "blockquote",
					children: processInlineMarkdown(blockquoteContent.join("\n")),
				});
				inBlockquote = false;
				blockquoteContent = [];
			}

			// Use unified AnchorGenerator for consistent heading processing and ID generation
			const headingInfo = AnchorGenerator.extractHeadingInfo(headingMatch);
			const anchorId = AnchorGenerator.generateAnchor(headingInfo);
			
			const level = headingInfo.level;
			const displayText = headingInfo.displayText;
			let tag: 'h3' | 'h4' = 'h3';

			// Map headings to Telegraph API compatible tags with visual hierarchy preservation
			// Telegraph API only supports h3 and h4 tags for headings
			switch (level) {
				case 1:
				case 2:
				case 3:
					// H1, H2, H3 → h3 (highest available level in Telegraph API)
					tag = 'h3';
					break;
				case 4:
				case 5:
				case 6:
				default:
					// H4 and below → h4
					tag = 'h4';
					break;
			}

			const processedChildren = processInlineMarkdown(displayText);
			
			// Only add ID attribute if target is EPUB
			// Telegraph API does not support ID attributes on headings
			const attrs: Record<string, string> = {};
			if (target === 'epub') {
				attrs.id = anchorId;
			}
			
			const node: TelegraphNode = { 
				tag, 
				children: processedChildren 
			};
			
			if (Object.keys(attrs).length > 0) {
				node.attrs = attrs;
			}
			
			nodes.push(node);
			continue;
		}

		// Handle lists (NOW AFTER HEADINGS) with nested list support
		const unorderedMatch = line.match(/^(\s*)([-*])\s+(.*)/);
		const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);

		if (unorderedMatch || orderedMatch) {
			// Close any open blocks before starting/continuing list
			if (listStack.length === 0) {
				if (inBlockquote) {
					nodes.push({
						tag: "blockquote",
						children: processInlineMarkdown(blockquoteContent.join("\n")),
					});
					inBlockquote = false;
					blockquoteContent = [];
				}
				flushParagraph();
			}

			const currentIndent = getIndentLevel(line);
			const listType: "ul" | "ol" = unorderedMatch ? "ul" : "ol";
			const textContent = (unorderedMatch?.[3] || orderedMatch?.[3] || "").trim();

			if (listStack.length === 0) {
				// Start a new root list
				listStack.push({ tag: listType, items: [], indent: currentIndent });
			} else {
				const topStack = listStack[listStack.length - 1];
				
				if (!topStack) {
					// Safety check: start new list if stack is somehow corrupted
					listStack.push({ tag: listType, items: [], indent: currentIndent });
				} else if (currentIndent > topStack.indent) {
					// Nested list: create new level
					listStack.push({ tag: listType, items: [], indent: currentIndent });
				} else if (currentIndent < topStack.indent) {
					// Dedent: close nested lists until we find the right level
					while (listStack.length > 1) {
						const currentTop = listStack[listStack.length - 1];
						if (!currentTop || currentTop.indent <= currentIndent) break;
						
						const child = listStack.pop();
						if (!child) break;
						
						const parent = listStack[listStack.length - 1];
						if (!parent) break;
						
						const childList: TelegraphNode = { tag: child.tag, children: child.items };
						
						// Append child list to the last item of parent
						if (parent.items.length > 0) {
							const lastItem = parent.items[parent.items.length - 1];
							if (lastItem && lastItem.children) {
								lastItem.children.push(childList);
							}
						}
					}
					
					// Check if current list type matches after dedent
					const newTop = listStack[listStack.length - 1];
					if (newTop && newTop.tag !== listType) {
						// Different list type at same level: close current and start new
						const closedList = flushListStack();
						if (closedList) nodes.push(closedList);
						listStack.push({ tag: listType, items: [], indent: currentIndent });
					}
				} else {
					// Same indent level: check if list type changed
					if (topStack.tag !== listType) {
						// Different list type at same level: close current stack and start new
						const closedList = flushListStack();
						if (closedList) nodes.push(closedList);
						listStack.push({ tag: listType, items: [], indent: currentIndent });
					}
				}
			}

			// Add list item to current (top) stack level. GFM task-list markers
			// (`[ ]` / `[x]`) become ballot-box glyphs so EPUB readers, which the
			// serializer can only feed non-void tags, show checkbox state without a
			// bare <input> element.
			if (textContent && listStack.length > 0) {
				const currentLevel = listStack[listStack.length - 1];
				if (currentLevel) {
					const taskMatch = /^\[([ xX])\]\s+/.exec(textContent);
					const liChildren = taskMatch
						? [
								taskMatch[1] === " " ? "☐ " : "☑ ",
								...processInlineMarkdown(textContent.slice(taskMatch[0].length)),
							]
						: processInlineMarkdown(textContent);
					currentLevel.items.push({
						tag: "li",
						children: liChildren,
					});
				}
			}
			continue;
		} else if (listStack.length > 0) {
			// Not a list item, but we have an active list
			if (line.trim() === "") {
				// Empty line: look ahead to see if the list continues after empty line(s)
				let nextNonEmptyIdx = i + 1;
				while (nextNonEmptyIdx < lines.length && (lines[nextNonEmptyIdx]?.trim() || "") === "") {
					nextNonEmptyIdx++;
				}
				
				const nextLine = lines[nextNonEmptyIdx] || "";
				// Check if next non-empty line is any list item
				const nextUnorderedMatch = nextLine.match(/^(\s*)([-*])\s+(.*)/);
				const nextOrderedMatch = nextLine.match(/^(\s*)(\d+)\.\s+(.*)/);
				
				if (nextUnorderedMatch || nextOrderedMatch) {
					// List continues after empty line(s), don't close it yet
					continue;
				} else {
					// List ends here, flush the stack
					const closedList = flushListStack();
					if (closedList) nodes.push(closedList);
					continue; // Don't add empty paragraph for the empty line
				}
			} else {
				// New content, close list and process as new paragraph
				const closedList = flushListStack();
				if (closedList) nodes.push(closedList);
				// Process current line as a new element (paragraph)
			}
		}

		// Handle horizontal rules (---, ***, ___ with optional spaces)
		if (line.match(/^\s*([-*_])(?:\s*\1){2,}\s*$/)) {
			// Close any open blocks before adding HR
			flushParagraph();
			if (listStack.length > 0) {
				const closedList = flushListStack();
				if (closedList) nodes.push(closedList);
			}
			if (inBlockquote) {
				nodes.push({
					tag: "blockquote",
					children: processInlineMarkdown(blockquoteContent.join("\n")),
				});
				inBlockquote = false;
				blockquoteContent = [];
			}
			nodes.push({ tag: "hr" });
			continue;
		}

		// Handle empty lines or plain paragraphs
		if (line.trim() === "") {
			// Empty line ends the current paragraph (if any)
			if (listStack.length === 0 && !inBlockquote && !inCodeBlock && !inTable) {
				flushParagraph();
			}
			continue;
		}

		// If we reach here, it's a plain paragraph line
		// Close any open blocks (lists, blockquotes) if this line is not part of them
		if (listStack.length > 0) {
			const closedList = flushListStack();
			if (closedList) nodes.push(closedList);
		}
		if (inBlockquote) {
			nodes.push({
				tag: "blockquote",
				children: processInlineMarkdown(blockquoteContent.join("\n")),
			});
			inBlockquote = false;
			blockquoteContent = [];
		}

		// Accumulate paragraph lines; they will be merged into full paragraphs
		currentParagraphLines.push(line);
	}

	// After loop, close any open blocks
	flushParagraph();
	if (inCodeBlock) {
		nodes.push({
			tag: "pre",
			children: [
				{ tag: "code", children: [codeBlockContent.join("\n").trimEnd()] },
			],
		}); // Trim end for final code block
	}
	if (listStack.length > 0) {
		const closedList = flushListStack();
		if (closedList) nodes.push(closedList);
	}
	if (inBlockquote) {
		nodes.push({
			tag: "blockquote",
			children: processInlineMarkdown(blockquoteContent.join("\n")),
		});
	}
	if (inTable) {
		nodes.push(parseTable(tableLines, target === "epub"));
	}

	// Filter out any empty paragraph nodes that might have been created unnecessarily
	return nodes.filter(
		(node) =>
			!(
				node.tag === "p" &&
				(!node.children ||
					node.children.length === 0 ||
					(node.children.length === 1 && node.children[0] === ""))
			),
	);
}

function processInlineMarkdown(text: string): (string | TelegraphNode)[] {
	const result: (string | TelegraphNode)[] = [];
	let currentIndex = 0;

	// Define patterns for different inline elements
	const patterns = [
		// Images: ![alt](src) – must go BEFORE link pattern to avoid overlap
		{ regex: /!\[([^[\]]*)\]\(([^()]*)\)/g, tag: "img", isImage: true },
		// GFM strikethrough: ~~text~~
		{ regex: /~~(.*?)~~/g, tag: "del" },
		{ regex: /\*\*(.*?)\*\*/g, tag: "strong" },
		{ regex: /__(.*?)__/g, tag: "strong" },
		{ regex: /\*(.*?)\*/g, tag: "em" },
		{ regex: /_(.*?)_/g, tag: "em" },
		{ regex: /`(.*?)`/g, tag: "code" },
		{ regex: /\[([^[\]]*(?:\[[^\]]*\][^[\]]*)*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, tag: "a", isLink: true },
	];

	// Find all matches with their positions
	const matches: Array<{
		index: number;
		length: number;
		tag: string;
		content: string;
		href?: string;
		isImage?: boolean;
	}> = [];

		for (const pattern of patterns as any[]) {
		pattern.regex.lastIndex = 0; // Reset regex
		let match: RegExpExecArray | null = null;
		match = pattern.regex.exec(text);
		while (match !== null) {
			if (match.index !== undefined) {
				if (pattern.isImage) {
					matches.push({
						index: match.index,
						length: match[0].length,
						tag: pattern.tag,
						content: match[1] || "",
						href: match[2] || "",
						isImage: true,
					});
				} else if (pattern.isLink) {
					matches.push({
						index: match.index,
						length: match[0].length,
						tag: pattern.tag,
						content: match[1] || "",
						href: match[2] || "",
					});
				} else {
					matches.push({
						index: match.index,
						length: match[0].length,
						tag: pattern.tag,
						content: match[1] || "",
					});
				}
			}
			match = pattern.regex.exec(text);
		}
	}

	// Sort matches by index to process them in order
	matches.sort((a, b) => a.index - b.index);

	// Process matches and build result
	for (const match of matches) {
		// Add plain text before this match
		if (match.index > currentIndex) {
			const plainText = text.substring(currentIndex, match.index);
			if (plainText) {
				result.push(plainText);
			}
		}

		// Skip if this match overlaps with previous processed content
		if (match.index < currentIndex) {
			continue;
		}

		// Add the formatted element
		if (match.isImage && match.href !== undefined) {
			result.push({
				tag: "img",
				attrs: { src: match.href, alt: match.content },
				children: [],
			});
		} else if (match.tag === "a" && match.href !== undefined) {
			result.push({
				tag: "a",
				attrs: { href: match.href },
				children: processInlineMarkdown(match.content),
			});
		} else if (match.tag === "code") {
			result.push({
				tag: match.tag,
				children: [match.content],
			});
		} else {
			result.push({
				tag: match.tag,
				children: processInlineMarkdown(match.content),
			});
		}

		currentIndex = match.index + match.length;
	}

	// Add any remaining plain text
	if (currentIndex < text.length) {
		const remainingText = text.substring(currentIndex);
		if (remainingText) {
			result.push(remainingText);
		}
	}

	// If no matches found, return the original text
	if (result.length === 0) {
		return [text];
	}

	return result;
}
