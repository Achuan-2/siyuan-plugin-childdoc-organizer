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

    private async handleBlockMenu({ detail }) {
        detail.menu.addItem({
            icon: "iconMove",
            label: "Move referenced docs and sort",
            click: async () => {
                const blockIds = [];
                for (const blockElement of detail.blockElements) {
                    const refs = Array.from(blockElement.querySelectorAll('span[data-type="block-ref"]'))
                        .map(el => el.getAttribute('data-id'));
                    blockIds.push(...refs);
                }
                console.log(blockIds);
                if (blockIds.length === 0) {
                    showMessage("No references found");
                    return;
                }

                await this.moveReferencedDocs(detail.protyle.block.rootID, blockIds);
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

    private async moveReferencedDocs(currentDocID: string, blockIds?: string[]) {
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

        // Get both moved docs and existing child docs in one query
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

        if (docsToMove.length > 0) {
            console.log(docToMove_sql)
            await moveDocsByID(docsToMove, currentDocID);
        }

        const docToSort_sql = await sql(sortQuery);
        const docsToSort = docToSort_sql.map(row => row.def_block_id);

        // Sort all referenced documents
        if (docsToSort.length > 0) {
            const currentDoc = await getBlockByID(currentDocID);
            const boxID = currentDoc.box;
            const sortJson = await getFile(`/data/${boxID}/.siyuan/sort.json`);
            const sortedResult = {};
            
            docsToSort.forEach((id, index) => {
                sortedResult[id] = index + 1;
            });

            for (let id in sortedResult) {
                sortJson[id] = sortedResult[id];
            }
            await putFile(`/data/${boxID}/.siyuan/sort.json`, sortJson);

            // 排序完之后需要刷新，刷新方式就是把文档树的当前文档子文档折叠再展开
            let element = document.querySelector(`.file-tree li[data-node-id="${currentDocID}"] > .b3-list-item__toggle--hl`);
            if (element) {
                element.click();
                element.click();
            }
        }
        // Show message
        const message = docsToMove.length > 0 
            ? `Moved ${docsToMove.length} documents and sorted ${docsToSort.length} documents`
            : `Sorted ${docsToSort.length} documents`;
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
