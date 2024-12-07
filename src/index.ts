import {
    Plugin,
    showMessage,
    confirm,
    Dialog,
    Menu,
    IModel,
    Protyle,
} from "siyuan";
import "@/index.scss";
import { SettingUtils } from "./libs/setting-utils";
import { svelteDialog } from "./libs/dialog";
import { sql, moveDocsByID, getBlockByID, getBlockDOM, getFile, putFile, refreshSql } from "./api";

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

    private getBoundBlockIds(attributeView: HTMLElement): string[] {
        return Array.from(
            attributeView.querySelectorAll('div.av__cell[data-block-id]:not([data-detached="true"])')
        ).map(el => el.getAttribute('data-block-id'));
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
                icon: "iconMove",
                label: "Move bound docs and sort",
                click: async () => {
                    const blockIds = this.getBoundBlockIds(block);
                    if (blockIds.length === 0) {
                        showMessage("No bound blocks found");
                        return;
                    }
                    await this.moveReferencedDocs(detail.protyle.block.rootID, blockIds, true);
                }
            });
            return;
        }

        // Add default menu item for other blocks
        this.addDefaultBlockMenuItem(detail.menu, detail.blockElements, detail.protyle);
    }

    private addDefaultBlockMenuItem(menu: Menu, blockElements: HTMLElement[], protyle: Protyle) {
        menu.addItem({
            icon: "iconMove",
            label: "Move referenced docs and sort",
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
                await this.moveReferencedDocs(protyle.block.rootID, blockIds);
            }
        });
    }

    private async handleDocumentMenu({ detail }) {
        detail.menu.addItem({
            icon: "iconMove",
            label: "Move referenced docs and sort",
            click: async () => {
                await this.moveReferencedDocs(detail.protyle.block.rootID);
            }
        });
    }

    private async getUnaffectedChildDocsCount(parentDocID: string, affectedDocIds: string[]): Promise<number> {
        const childDocsQuery = `
            SELECT DISTINCT id 
            FROM blocks 
            WHERE type = 'd' 
            AND path LIKE '%/${parentDocID}/%'
            AND path NOT LIKE '%/${parentDocID}/%/%'
        `;
        const childDocs = await sql(childDocsQuery);
        return childDocs.filter(doc => !affectedDocIds.includes(doc.id)).length;
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

    private async moveReferencedDocs(currentDocID: string, blockIds?: string[], isAttributeView: boolean = false) {
        showMessage("Processing...");
        await refreshSql();

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
        const docsToMove = docToMove_sql.map(row => row.def_block_id);

        if (docsToMove.length > 0) {
            console.log(docToMove_sql)
            await moveDocsByID(docsToMove, currentDocID);
        }
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
                
                // Get and sort unaffected docs
                const unaffectedDocs = await this.getUnaffectedChildDocs(currentDocID, sortedRootIds, sortJson);
                
                // Update sort values for unaffected docs
                unaffectedDocs.forEach((doc, index) => {
                    sortJson[doc.id] = index + 1;
                });
                
                // Apply sorting for affected docs after unaffected ones
                const unaffectedCount = unaffectedDocs.length;
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
                
                // Get and sort unaffected docs
                const unaffectedDocs = await this.getUnaffectedChildDocs(currentDocID, docsToSort, sortJson);
                
                // Update sort values for unaffected docs
                unaffectedDocs.forEach((doc, index) => {
                    sortJson[doc.id] = index + 1;
                });
                
                // Update sort values for affected docs
                const unaffectedCount = unaffectedDocs.length;
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

        // Show message
        const message = docsToMove.length > 0 
            ? isAttributeView 
                ? `Moved ${docsToMove.length} documents`
                : `Moved ${docsToMove.length} documents and sorted documents`
            : `No documents were moved`;
        showMessage(message);
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
