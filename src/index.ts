import {
    Plugin,
    showMessage,
    confirm,
    Dialog,
    Menu,
    IModel,
    Protyle,
    fetchSyncPost,
} from "siyuan";
import "@/index.scss";
import { SettingUtils } from "./libs/setting-utils";
import { svelteDialog } from "./libs/dialog";
import { sql, moveDocsByID, getBlockByID, getBlockDOM, getFile, putFile, refreshSql, createDocWithMd, updateBlock} from "./api";

const STORAGE_NAME = "config";

export default class DocMoverPlugin extends Plugin {
    private isMobile: boolean;
    private settingUtils: SettingUtils;

    async onload() {
        // 文档块标添加菜单
        this.eventBus.on('click-editortitleicon', this.handleDocumentMenu.bind(this));
        // 文档树添加菜单
        this.eventBus.on("open-menu-doctree", this.handleFiletreeMenu.bind(this));
        // 块菜单添加菜单
        this.eventBus.on('click-blockicon', this.handleBlockMenu.bind(this));
    }

    private isAttributeView(element: HTMLElement): boolean {
        return element.getAttribute('data-type') === 'NodeAttributeView';
    }

    private getAttributeViewIDs(element: HTMLElement): { avID: string, viewID: string } {
        return {
            avID: element.getAttribute('data-av-id'),
            viewID: element.getAttribute('custom-sy-av-view')
        };
    }

    private async getAllBoundBlockIds(avID: string, viewID: string): Promise<string[]> {
        const response = await fetchSyncPost("/api/av/renderAttributeView", {
            id: avID,
            viewID: viewID,
            pageSize: 9999999,
            page: 1
        });
        
        return response.data.view.rows.map(item => item.id);
    }

    private async getBoundBlockIds(attributeView: HTMLElement): Promise<string[]> {
        const { avID, viewID } = this.getAttributeViewIDs(attributeView);
        return await this.getAllBoundBlockIds(avID, viewID);
    }

    private async handleBlockMenu({ detail }) {
        // Only handle single block selection
        if (detail.blockElements.length !== 1) {
            return this.addDefaultBlockMenuItem(detail.menu, detail.blockElements, detail.protyle);
        }

        const block = detail.blockElements[0];
        
        // Handle attribute view specifically
        if (this.isAttributeView(block)) {
            detail.menu.addItem({
                icon: "iconSort",
                label: this.i18n.childDocOrganizer,
                submenu: [
                    {
                        icon: "iconMove",
                        label: this.i18n.moveAndSort,
                        click: async () => {
                            const blockIds = await this.getBoundBlockIds(block);
                            if (blockIds.length === 0) {
                                showMessage("No referenced blocks found");
                                return;
                            }
                            await this.moveAndSortReferencedDocs(detail.protyle.block.rootID, blockIds, true);
                        }
                    },
                    {
                        icon: "iconSort",
                        label: this.i18n.onlySort,
                        click: async () => {
                            const blockIds = await this.getBoundBlockIds(block);
                            if (blockIds.length === 0) {
                                showMessage("No referenced blocks found");
                                return;
                            }
                            await this.moveAndSortReferencedDocs(detail.protyle.block.rootID, blockIds, true, true);
                        }
                    }
                ]
            });
            return;
        }

        // Add default menu items for other blocks
        this.addDefaultBlockMenuItem(detail.menu, detail.blockElements, detail.protyle);
    }

    private hasBlockRef(element: HTMLElement): boolean {
        return element.querySelector('span[data-type="block-ref"]') !== null;
    }

    private async processListItem(
        item: HTMLElement,
        parentDocID: string,
        boxID: string,
        parentPath: string
    ): Promise<string | null> {
        const paragraph = item.querySelector('div.p');
        if (!paragraph) return null;

        let currentDocID = parentDocID;
        let currentPath = parentPath;
        
        // If no block reference exists, create new doc and reference
        if (!this.hasBlockRef(paragraph)) {
            const content = paragraph.querySelector('div:first-child')?.textContent?.trim() || '';
            const paragraphId = paragraph.getAttribute('data-node-id');
            
            if (content && paragraphId) {
                currentDocID = await createDocWithMd(boxID, `${parentPath}/${content}`, "");
                const refMd = `<span data-type="block-ref" data-id="${currentDocID}" data-subtype="d">${content}</span>`;
                await updateBlock("markdown", refMd, paragraphId);
                currentPath = `${parentPath}/${content}`;
            }
        } else {
            // If block reference exists, get its target doc ID for nested processing
            const blockRef = paragraph.querySelector('span[data-type="block-ref"]');
            const refDocID = blockRef?.getAttribute('data-id');
            if (refDocID) {
                currentDocID = refDocID;
                const refDoc = await getBlockByID(refDocID);
                currentPath = refDoc.hpath;
            }
        }

        // Always process nested list if it exists, using either new doc ID or referenced doc ID
        const nestedList = item.querySelector(':scope > div.list');
        if (nestedList) {
            const listItems = Array.from(nestedList.querySelectorAll(':scope > div.li'));
            for (const nestedItem of listItems) {
                await this.processListItem(nestedItem, currentDocID, boxID, currentPath);
            }
        }

        return currentDocID;
    }

    private async createChildDocsFromParagraphs(block: HTMLElement, parentDocID: string) {
        const parentDoc = await getBlockByID(parentDocID);
        const boxID = parentDoc.box;
        const parentPath = parentDoc.hpath;

        // Handle single paragraph block
        if (block.classList.contains('p')) {
            // Skip if block already contains a block reference
            if (this.hasBlockRef(block)) return;

            const content = block.querySelector('div:first-child')?.textContent?.trim() || '';
            const id = block.getAttribute('data-node-id');
            
            if (content && id) {
                const docID = await createDocWithMd(boxID, `${parentPath}/${content}`, "");
                const refMd = `<span data-type="block-ref" data-id="${docID}" data-subtype="d">${content}</span>`;
                await updateBlock("markdown", refMd, id);
            }
            return;
        }

        // Handle list block
        if (block.classList.contains('list')) {
            const listItems = Array.from(block.querySelectorAll(':scope > div.li'));
            for (const item of listItems) {
                await this.processListItem(item, parentDocID, boxID, parentPath);
            }
            return;
        }

        // Handle block containing multiple paragraphs
        const paragraphElements = Array.from(block.querySelectorAll('div.p'));
        if (paragraphElements.length === 0) {
            showMessage(this.i18n.noValidParagraphs);
            return;
        }

        showMessage(this.i18n.creatingDocs.replace("{count}", paragraphElements.length.toString()));

        for (const paragraph of paragraphElements) {
            // Skip if paragraph already contains a block reference
            if (this.hasBlockRef(paragraph)) continue;

            const content = paragraph.querySelector('div:first-child')?.textContent?.trim() || '';
            const id = paragraph.getAttribute('data-node-id');
            
            if (content && id) {
                try {
                    const docID = await createDocWithMd(boxID, `${parentPath}/${content}`, "");
                    const refMd = `<span data-type="block-ref" data-id="${docID}" data-subtype="d">${content}</span>`;
                    await updateBlock("markdown", refMd, id);
                } catch (e) {
                    console.error(`Failed to create document for "${content}"`, e);
                }
            }
        }

        showMessage(this.i18n.createdDocs.replace("{count}", paragraphElements.length.toString()));
    }

    private addDefaultBlockMenuItem(menu: Menu, blockElements: HTMLElement[], protyle: Protyle) {
        menu.addItem({
            icon: "iconSort",
            label: this.i18n.childDocOrganizer,
            submenu: [
                {
                    icon: "iconMove",
                    label: this.i18n.moveAndSort,
                    click: async () => {
                        const blockIds = [];
                        for (const blockElement of blockElements) {
                            const refs = Array.from(blockElement.querySelectorAll('span[data-type="block-ref"]'))
                                .map(el => el.getAttribute('data-id'));
                            blockIds.push(...refs);
                        }
                        if (blockIds.length === 0) {
                            showMessage(this.i18n.noReferencesFound);
                            return;
                        }
                        await this.moveAndSortReferencedDocs(protyle.block.rootID, blockIds);
                    }
                },
                {
                    icon: "iconSort",
                    label: this.i18n.onlySort,
                    click: async () => {
                        const blockIds = [];
                        for (const blockElement of blockElements) {
                            const refs = Array.from(blockElement.querySelectorAll('span[data-type="block-ref"]'))
                                .map(el => el.getAttribute('data-id'));
                            blockIds.push(...refs);
                        }
                        if (blockIds.length === 0) {
                            showMessage("No references found");
                            return;
                        }
                        await this.moveAndSortReferencedDocs(protyle.block.rootID, blockIds, false, true);
                    }
                },
                {
                    icon: "iconAdd",
                    label: this.i18n.createFromParagraphs,
                    click: async () => {
                        for (const blockElement of blockElements) {
                            await this.createChildDocsFromParagraphs(blockElement, protyle.block.rootID);
                        }
                        // sort referenced docs after creating child docs
                        await this.moveAndSortReferencedDocs(protyle.block.rootID, undefined, false, true);
                    }
                }
            ]
        });
    }

    private async handleFiletreeMenu({ detail }) {
        const elements = Array.from(detail.elements); // 将 NodeList 或其他集合转换为数组
        if (elements.length === 0) return;

        // Check if any element is notebook root
        const hasNotebook = elements.some((element: HTMLElement) => 
            element.getAttribute("data-type") === "navigation-root"
        );

        if (!hasNotebook) {
            detail.menu.addItem({
                icon: "iconSort",
                label: this.i18n.childDocOrganizer,
                submenu: [
                    {
                        icon: "iconMove",
                        label: this.i18n.moveAndSort,
                        click: async () => {
                            for (const element of elements) {
                                const id = element.getAttribute("data-node-id");
                                console.log(id)
                                if (id) {
                                    await this.moveAndSortReferencedDocs(id);
                                }
                            }
                        }
                    },
                    {
                        icon: "iconSort",
                        label: this.i18n.onlySort,
                        click: async () => {
                            for (const element of elements) {
                                const id = element.getAttribute("data-node-id");
                                if (id) {
                                    await this.moveAndSortReferencedDocs(id, undefined, false, true);
                                }
                            }
                        }
                    }
                ]
            });
        }
    }
    private async handleDocumentMenu({ detail }) {
        detail.menu.addItem({
            icon: "iconSort",
            label: this.i18n.childDocOrganizer,
            submenu: [
                {
                    icon: "iconMove",
                    label: this.i18n.moveAndSort,
                    click: async () => {
                        await this.moveAndSortReferencedDocs(detail.protyle.block.rootID);
                    }
                },
                {
                    icon: "iconSort",
                    label: this.i18n.onlySort,
                    click: async () => {
                        await this.moveAndSortReferencedDocs(detail.protyle.block.rootID, undefined, false, true);
                    }
                }
            ]
        });
    }

    private async getUnaffectedChildDocs(parentDocID: string, affectedDocIds: string[], sortJson: any): Promise<{id: string, sortValue: number}[]> {
        const childDocsQuery = `
            SELECT DISTINCT id 
            FROM blocks 
            WHERE type = 'd' 
            AND path LIKE '%/${parentDocID}/%'
            AND path NOT LIKE '%/${parentDocID}/%/%'
        `;
        const childDocs = await sql(childDocsQuery);
        return childDocs
            .filter(doc => !affectedDocIds.includes(doc.id))
            .map(doc => ({
                id: doc.id,
                sortValue: sortJson[doc.id] || 0
            }))
            .sort((a, b) => a.sortValue - b.sortValue);
    }

    private async moveAndSortReferencedDocs(currentDocID: string, blockIds?: string[], isAttributeView: boolean = false, onlySort: boolean = false) {
        showMessage(this.i18n.processing);
        await refreshSql();
        console.log(onlySort)
        console.log(onlySort)
        let movedCount = 0;
        const docsToMove: string[] = [];
        if (!onlySort) {
            const moveQuery = blockIds && blockIds.length > 0 
                ? `
                    SELECT DISTINCT root_id as def_block_id
                    FROM blocks 
                    WHERE id IN (${blockIds.map(id => `'${id}'`).join(',')})
                    AND type = 'd'
                    AND path NOT LIKE '%${currentDocID}%'
                `
                : `
                    SELECT DISTINCT r.def_block_id 
                    FROM refs r
                    JOIN blocks b ON r.def_block_id = b.id
                    WHERE r.root_id = '${currentDocID}' 
                    AND r.def_block_id = r.def_block_root_id
                    AND b.path NOT LIKE '%${currentDocID}%'
                `;

            const docToMove_sql = await sql(moveQuery);
            docsToMove.push(...docToMove_sql.map(row => row.def_block_id));
            console.log(docsToMove)
            if (docsToMove.length > 0) {
                await moveDocsByID(docsToMove, currentDocID);
                movedCount = docsToMove.length;
                await refreshSql();
            }
        }

        let sortedCount = 0;
        let unaffectedCount = 0;
        
        // Handle sorting
        if (isAttributeView && blockIds && blockIds.length > 0) {
            // Get root IDs for the bound blocks in order
            const rootIdsQuery = `
                SELECT DISTINCT id, root_id as def_block_id
                FROM blocks 
                WHERE id IN (${blockIds.map(id => `'${id}'`).join(',')})
                AND type = 'd'
                AND (
                    id IN (${docsToMove.map(id => `'${id}'`).join(',') || "''"})
                    OR (
                        path LIKE '%/${currentDocID}/%'
                        AND path NOT LIKE '%/${currentDocID}/%/%'
                    )
                )
            `;
            const blockRoots = await sql(rootIdsQuery);
            
            // For document blocks, we can use the id directly since id = root_id
            const sortedRootIds = blockIds
                .filter(id => blockRoots.some(row => row.id === id))
                .map(id => id);

            if (sortedRootIds.length > 0) {
                const currentDoc = await getBlockByID(currentDocID);
                const boxID = currentDoc.box;
                const sortJson = await getFile(`/data/${boxID}/.siyuan/sort.json`);
                
                const unaffectedDocs = await this.getUnaffectedChildDocs(currentDocID, sortedRootIds, sortJson);
                sortedCount = sortedRootIds.length;
                
                // Get and sort unaffected docs
                unaffectedDocs.forEach((doc, index) => {
                    sortJson[doc.id] = index + 1;
                });
                
                // Apply sorting for affected docs after unaffected ones
                unaffectedCount = unaffectedDocs.length;
                sortedRootIds.forEach((id, index) => {
                    sortJson[id] = unaffectedCount + index + 1;
                });

                await putFile(`/data/${boxID}/.siyuan/sort.json`, sortJson);
            }
        } else if (!isAttributeView) {
            // Original sorting logic for normal documents
            const sortQuery = `
                SELECT DISTINCT def_block_id
                FROM refs
                WHERE root_id = '${currentDocID}'
                AND def_block_id = def_block_root_id
                AND (
                    def_block_id IN (${docsToMove.map(id => `'${id}'`).join(',') || "''"})
                    OR (
                        def_block_path LIKE '%/${currentDocID}/%'
                        AND def_block_path NOT LIKE '%/${currentDocID}/%/%'
                    )
                )
            `;
            const docToSort_sql = await sql(sortQuery);
            const docsToSort = docToSort_sql.map(row => row.def_block_id);
            if (docsToSort.length > 0) {
                const currentDoc = await getBlockByID(currentDocID);
                const boxID = currentDoc.box;
                const sortJson = await getFile(`/data/${boxID}/.siyuan/sort.json`);
                
                const unaffectedDocs = await this.getUnaffectedChildDocs(currentDocID, docsToSort, sortJson);
                sortedCount = docsToSort.length;
                
                // Get and sort unaffected docs
                unaffectedDocs.forEach((doc, index) => {
                    sortJson[doc.id] = index + 1;
                });
                
                // Update sort values for affected docs
                unaffectedCount = unaffectedDocs.length;
                docsToSort.forEach((id, index) => {
                    sortJson[id] = unaffectedCount + index + 1;
                });

                await putFile(`/data/${boxID}/.siyuan/sort.json`, sortJson);
            }
        }

        // Refresh file tree if needed
        let element = document.querySelector(`.file-tree li[data-node-id="${currentDocID}"] > .b3-list-item__toggle--hl`);
        if (element) {
            element.click();
            element.click();
        }

        // Show detailed message
        let message = [];
        if (!onlySort && movedCount > 0) {
            message.push(this.i18n.movedDocs.replace("{count}", movedCount.toString()));
        }
        if (sortedCount > 0 || unaffectedCount > 0) {
            message.push(this.i18n.sortedDocs
                .replace("{count}", (sortedCount + unaffectedCount).toString())
                .replace("{affected}", sortedCount.toString())
                .replace("{unaffected}", unaffectedCount.toString()));
        }
        showMessage(message.length > 0 ? message.join(', ') : this.i18n.noDocsProcessed);

    }

    onLayoutReady() {
        // ...existing code...
    }

    async onunload() {
        // ...existing code...
    }

    uninstall() {
        // ...existing code...
    }
}
