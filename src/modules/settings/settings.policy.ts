import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/decorators/actor.decorator';
import type { PanelSettings } from './panel-settings.types';

@Injectable()
export class SettingsPolicy {
  sanitizeUpdate(actor: Actor, input: Partial<PanelSettings>, currentBackupPolicy: PanelSettings['backupPolicy']) {
    if (actor.role === 'owner') return input;
    return { ...input, backupPolicy: currentBackupPolicy };
  }
}
