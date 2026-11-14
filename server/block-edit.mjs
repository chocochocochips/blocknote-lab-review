import {createHash} from 'node:crypto';
import {stableJson} from '../shared/block-edit.mjs';
export const blockHash=block=>createHash('sha256').update(stableJson(block)).digest('hex');
