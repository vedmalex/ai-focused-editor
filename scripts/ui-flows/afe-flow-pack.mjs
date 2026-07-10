/**
 * AI Focused Editor — playwright-cli flow scenario pack.
 *
 * Consumed by the playwright-flow-scenario-builder collector:
 *   bash <skill>/scripts/run-flow-artifacts.sh scripts/ui-flows/afe-flow-pack.mjs
 * or through the repo wrapper: bun run test:ui:flows
 *
 * Scenarios drive the Theia workbench through page-context DOM events
 * (Lumino menus react to mousedown/mouseup, trees open on dblclick).
 */

const HELPERS = `
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el && el.getBoundingClientRect().width > 0;
  // Lumino 2 widgets listen for pointer events; dispatch both pointer and
  // mouse variants at the element's center coordinates.
  const mouse = (el, type) => {
    const box = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
      button: 0, buttons: type.endsWith('down') ? 1 : 0, pointerId: 1, isPrimary: true
    };
    const pointerType = type.replace('mouse', 'pointer');
    if (pointerType !== type && typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent(pointerType, opts));
    }
    el.dispatchEvent(new MouseEvent(type, opts));
  };
  const pressItem = el => { mouse(el, 'mousedown'); mouse(el, 'mouseup'); mouse(el, 'click'); };
  const menuBarItem = label => [...document.querySelectorAll('.lm-MenuBar-itemLabel, .p-MenuBar-itemLabel')]
    .filter(visible).find(el => el.textContent.trim() === label);
  const openMenu = async label => {
    const item = menuBarItem(label);
    if (!item) { throw new Error('Menu bar item not found: ' + label); }
    mouse(item.closest('.lm-MenuBar-item, .p-MenuBar-item') || item, 'mousedown');
    await sleep(400);
  };
  const menuItems = () => [...document.querySelectorAll('.lm-Menu-itemLabel, .p-Menu-itemLabel')].filter(visible);
  const menuItem = text => menuItems().find(el => el.textContent.trim().includes(text));
  const clickMenuItem = async text => {
    const label = menuItem(text);
    if (!label) { throw new Error('Menu item not found: ' + text + ' (visible: ' + menuItems().map(el => el.textContent.trim()).join(' | ') + ')'); }
    const row = label.closest('.lm-Menu-item, .p-Menu-item') || label;
    mouse(row, 'mousemove');
    await sleep(150);
    mouse(row, 'mousedown');
    mouse(row, 'mouseup');
    await sleep(400);
  };
  const hoverMenuItem = async text => {
    const label = menuItem(text);
    if (!label) { throw new Error('Menu item not found: ' + text + ' (visible: ' + menuItems().map(el => el.textContent.trim()).join(' | ') + ')'); }
    const row = label.closest('.lm-Menu-item, .p-Menu-item') || label;
    mouse(row, 'mouseenter');
    mouse(row, 'mousemove');
    await sleep(600);
  };
  const closeMenus = async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(200);
  };
  const waitForText = async (text, timeoutMs = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.body.innerText.includes(text)) { return; }
      await sleep(500);
    }
    throw new Error('Timed out waiting for text: ' + text);
  };
  const treeNode = text => [...document.querySelectorAll('.theia-TreeNode')]
    .filter(visible).find(el => el.textContent.includes(text));
`;

const action = body => ({ eval: `(async () => {${HELPERS}\n${body}\nreturn true; })()` });

export default {
  version: '2.0.0',
  description: 'AI Focused Editor workbench flow checks (menu integrity, tree, editor/preview, model config, build menu)',
  viewports: {
    desktop: { width: 1440, height: 900 }
  },
  profiles: {
    default: {
      localStorage: {}
    }
  },
  actions: {
    wait_for_workbench: action(`
      await waitForText('File', 45000);
      await waitForText('Manuscript', 45000);
      await sleep(2000);
    `),
    assert_single_manuscript_menu: action(`
      await waitForText('Manuscript', 45000);
      const labels = [...document.querySelectorAll('.lm-MenuBar-itemLabel, .p-MenuBar-itemLabel')]
        .filter(visible).map(el => el.textContent.trim());
      const manuscriptCount = labels.filter(label => label === 'Manuscript').length;
      if (manuscriptCount !== 1) {
        throw new Error('Expected exactly 1 Manuscript menu, found ' + manuscriptCount + ' (menu bar: ' + labels.join(' | ') + ')');
      }
      await openMenu('Manuscript');
      const knowledgeCount = menuItems().map(el => el.textContent.trim()).filter(text => text === 'Knowledge').length;
      if (knowledgeCount !== 1) {
        throw new Error('Expected exactly 1 Knowledge submenu, found ' + knowledgeCount);
      }
      const buildCount = menuItems().map(el => el.textContent.trim()).filter(text => text === 'Build').length;
      if (buildCount !== 1) {
        throw new Error('Expected exactly 1 Build submenu, found ' + buildCount);
      }
      await closeMenus();
    `),
    wait_for_manuscript_tree: action(`
      await waitForText('Part One', 45000);
      if (!treeNode('Chapter 1')) { throw new Error('Manuscript tree does not show Chapter 1'); }
      if (!treeNode('Draft Notes')) { throw new Error('Manuscript tree does not show the excluded Draft Notes node'); }
    `),
    open_chapter_and_preview: action(`
      await waitForText('Chapter 1', 45000);
      const node = treeNode('Chapter 1');
      if (!node) { throw new Error('Chapter 1 tree node not found'); }
      mouse(node, 'mousedown'); mouse(node, 'mouseup');
      mouse(node, 'dblclick');
      await waitForText('The Field of Decision', 30000);
      await openMenu('Manuscript');
      await clickMenuItem('Semantic Preview');
      await waitForText('semantic tag(s)', 20000);
    `),
    open_model_config: action(`
      await openMenu('Manuscript');
      await clickMenuItem('AI Model Config');
      await waitForText('AI Profiles', 20000);
    `),
    assert_build_menu_entries: action(`
      await openMenu('Manuscript');
      await hoverMenuItem('Build');
      const required = ['Build Manuscript Markdown', 'Build Manuscript HTML', 'Build Manuscript EPUB', 'Build Manuscript PDF', 'Open Last Manuscript Build'];
      const texts = menuItems().map(el => el.textContent.trim());
      const missing = required.filter(entry => !texts.some(text => text.includes(entry)));
      if (missing.length > 0) {
        throw new Error('Build menu is missing: ' + missing.join(', ') + ' (visible: ' + texts.join(' | ') + ')');
      }
      await closeMenus();
    `)
  },
  scenarios: [
    {
      id: 'AFE-01-SHELL-BOOT',
      flowIds: ['AFE-01'],
      profile: 'default',
      path: '/',
      viewport: 'desktop',
      action: 'wait_for_workbench',
      requiredText: ['File', 'Manuscript'],
      screenshot: 'afe-01-shell.png'
    },
    {
      id: 'AFE-02-MENU-NO-DUPLICATES',
      flowIds: ['AFE-02'],
      profile: 'default',
      path: '/',
      viewport: 'desktop',
      action: 'assert_single_manuscript_menu',
      requiredText: [],
      screenshot: 'afe-02-menu.png'
    },
    {
      id: 'AFE-03-MANUSCRIPT-TREE',
      flowIds: ['AFE-03'],
      profile: 'default',
      path: '/',
      viewport: 'desktop',
      action: 'wait_for_manuscript_tree',
      requiredText: ['Part One', 'Chapter 1'],
      screenshot: 'afe-03-tree.png'
    },
    {
      id: 'AFE-04-EDITOR-PREVIEW',
      flowIds: ['AFE-04'],
      profile: 'default',
      path: '/',
      viewport: 'desktop',
      action: 'open_chapter_and_preview',
      requiredText: ['The Field of Decision', 'semantic tag(s)'],
      screenshot: 'afe-04-preview.png'
    },
    {
      id: 'AFE-05-MODEL-CONFIG',
      flowIds: ['AFE-05'],
      profile: 'default',
      path: '/',
      viewport: 'desktop',
      action: 'open_model_config',
      requiredText: ['AI Profiles', 'Provider'],
      screenshot: 'afe-05-model-config.png'
    },
    {
      id: 'AFE-06-BUILD-MENU',
      flowIds: ['AFE-06'],
      profile: 'default',
      path: '/',
      viewport: 'desktop',
      action: 'assert_build_menu_entries',
      requiredText: [],
      screenshot: 'afe-06-build-menu.png'
    }
  ]
};
