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
                label: "ChildDoc Organizer",
                submenu: [
                    {
                        icon: "iconMove",
                        label: "Move referenced docs as childdocs and sort",
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
                        label: "Only sort referenced childdocs",
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

    private async createChildDocsFromParagraphs(block: HTMLElement, parentDocID: string) {
        // If block itself is a paragraph, use it directly
        const paragraphElements = block.classList.contains('p') ?
            [block] :
            Array.from(block.querySelectorAll('div.p'));

        const paragraphInfos = paragraphElements
            .map(el => ({
                content: el.querySelector('div:first-child')?.textContent?.trim() || '',
                id: el.getAttribute('data-node-id')
            }))
            .filter(info => info.content.length > 0);

        if (paragraphInfos.length === 0) {
            showMessage("No valid paragraphs found");
            return;
        }
    
        showMessage(`Creating ${paragraphInfos.length} documents...`);
    
        // Get parent document info for creating child docs
        const parentDoc = await getBlockByID(parentDocID);
        const boxID = parentDoc.box;
        const parentPath = parentDoc.hpath;
    
        for (const { content, id } of paragraphInfos) {
            // Create new document
            try {
                const docID = await createDocWithMd(boxID, `${parentPath}/${content}`, "");
                
                // Replace paragraph content with block reference
                const refMd = `<span data-type="block-ref" data-id="${docID}" data-subtype="d">${content}</span>`;
                await updateBlock("markdown", refMd, id);
            } catch (e) {
                console.error(`Failed to create document for "${content}"`, e);
            }
        }
    
        showMessage(`Created ${paragraphInfos.length} documents`);
    }


    private addDefaultBlockMenuItem(menu: Menu, blockElements: HTMLElement[], protyle: Protyle) {
        menu.addItem({
            icon: "iconSort",
            label: "ChildDoc Organizer",
            submenu: [
                {
                    icon: "iconMove",
                    label: "Move referenced docs as childdocs and sort",
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
                        await this.moveAndSortReferencedDocs(protyle.block.rootID, blockIds);
                    }
                },
                {
                    icon: "iconSort",
                    label: "Only sort referenced childdocs",
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
                    label: "Create Child Docs from Paragraphs",
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

    private async handleDocumentMenu({ detail }) {
        detail.menu.addItem({
            icon: "iconSort",
            label: "ChildDoc Organizer",
            submenu: [
                {
                    icon: "iconMove",
                    label: "Move referenced docs as childdocs and sort",
                    click: async () => {
                        await this.moveAndSortReferencedDocs(detail.protyle.block.rootID);
                    }
                },
                {
                    icon: "iconSort",
                    label: "Only sort referenced childdocs",
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
        showMessage("Processing...");
        await refreshSql();

        let movedCount = 0;
        const docsToMove: string[] = [];

        if (!onlySort) {
            let moveQuery = `
                SELECT DISTINCT def_block_id 
                FROM refs 
                WHERE root_id = '${currentDocID}' 
                AND def_block_id = def_block_root_id
                AND def_block_path NOT LIKE '%${currentDocID}%'
            `;

            if (blockIds && blockIds.length > 0) {
                moveQuery = `
                    SELECT DISTINCT root_id as def_block_id
                    FROM blocks 
                    WHERE id IN (${blockIds.map(id => `'${id}'`).join(',')})
                    AND type = 'd'
                    AND path NOT LIKE '%${currentDocID}%'
                `;
            }

            const docToMove_sql = await sql(moveQuery);
            docsToMove.push(...docToMove_sql.map(row => row.def_block_id));

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
            message.push(`Moved ${movedCount} documents`);
        }
        if (sortedCount > 0 || unaffectedCount > 0) {
            message.push(`Sorted ${sortedCount + unaffectedCount} documents (${sortedCount} affected, ${unaffectedCount} unaffected)`);
        }
        showMessage(message.length > 0 ? message.join(', ') : 'No documents were moved or sorted');

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
