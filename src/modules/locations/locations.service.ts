import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';

export interface LocationEntry {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

@Injectable()
export class LocationsService implements OnModuleInit {
  private readonly locations = new Map<string, LocationEntry>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'locations.json');

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit() {
    if (this.database.enabled) {
      const rows = await this.database.query(`SELECT DISTINCT location FROM agents WHERE location IS NOT NULL AND location <> ''`);
      for (const row of rows) {
        const id = this.id(row.location);
        if (id && !await this.get(id)) await this.create({ id, name: this.displayName(id), description: 'Imported from existing node configuration.' });
      }
      return;
    }
    if (fs.existsSync(this.dataFile)) {
      for (const location of JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as LocationEntry[]) this.locations.set(location.id, location);
    }
    const agentsFile = path.join(__dirname, '..', '..', 'data', 'agents.json');
    if (fs.existsSync(agentsFile)) {
      for (const agent of JSON.parse(fs.readFileSync(agentsFile, 'utf8')) as Array<{ location?: string }>) {
        const id = this.id(agent.location);
        if (!id || this.locations.has(id)) continue;
        const now = new Date().toISOString();
        this.locations.set(id, { id, name: this.displayName(id), description: 'Imported from existing node configuration.', createdAt: now, updatedAt: now, nodeCount: 0 });
      }
      this.save();
    }
  }

  async list(): Promise<LocationEntry[]> {
    if (this.database.enabled) {
      const rows = await this.database.query(`
        SELECT locations.*, COUNT(agents.node_id) AS node_count
        FROM locations
        LEFT JOIN agents ON agents.location = locations.id
        GROUP BY locations.id, locations.name, locations.description, locations.created_at, locations.updated_at
        ORDER BY locations.name ASC
      `);
      return rows.map((row: any) => this.fromRow(row));
    }
    const counts = this.jsonNodeCounts();
    return Array.from(this.locations.values())
      .map(location => ({ ...location, nodeCount: counts.get(location.id) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string) {
    const normalized = this.id(id);
    return (await this.list()).find(location => location.id === normalized);
  }

  async create(input: { id?: unknown; name?: unknown; description?: unknown }) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('location name is required');
    const id = this.id(input.id || name);
    if (!id) throw new Error('location code is required');
    if (await this.get(id)) throw new Error(`location "${id}" already exists`);
    const now = new Date().toISOString();
    const entry: LocationEntry = { id, name, description: String(input.description || '').trim(), createdAt: now, updatedAt: now, nodeCount: 0 };
    if (this.database.enabled) {
      await this.database.query(
        `INSERT INTO locations (id, name, description, created_at, updated_at) VALUES (${this.database.placeholders(5)})`,
        [entry.id, entry.name, entry.description, entry.createdAt, entry.updatedAt]
      );
    } else {
      this.locations.set(id, entry);
      this.save();
    }
    return entry;
  }

  async update(idValue: string, input: { id?: unknown; name?: unknown; description?: unknown }) {
    const id = this.id(idValue);
    const existing = await this.get(id);
    if (!existing) throw new Error('location not found');
    const nextId = input.id === undefined ? id : this.id(input.id);
    if (!nextId) throw new Error('location code is required');
    const name = input.name === undefined ? existing.name : String(input.name || '').trim();
    if (!name) throw new Error('location name is required');
    if (nextId !== id) {
      if (await this.get(nextId)) throw new Error(`location "${nextId}" already exists`);
      if (await this.inUse(id)) throw new Error('move all nodes out of this location before changing its ID');
    }
    const next = { ...existing, id: nextId, name, description: input.description === undefined ? existing.description : String(input.description || '').trim(), updatedAt: new Date().toISOString() };
    if (this.database.enabled) {
      await this.database.query(
        `UPDATE locations SET id = ${this.database.placeholders(1)}, name = ${this.database.placeholders(1, 2)}, description = ${this.database.placeholders(1, 3)}, updated_at = ${this.database.placeholders(1, 4)} WHERE id = ${this.database.placeholders(1, 5)}`,
        [next.id, next.name, next.description, next.updatedAt, id]
      );
    } else {
      this.locations.delete(id);
      this.locations.set(nextId, next);
      this.save();
    }
    return next;
  }

  async remove(idValue: string) {
    const id = this.id(idValue);
    const rows = this.database.enabled
      ? await this.database.query(`SELECT COUNT(*) AS count FROM agents WHERE location = ${this.database.placeholders(1)}`, [id])
      : [];
    const jsonInUse = !this.database.enabled && (this.jsonNodeCounts().get(id) || 0) > 0;
    if (Number(rows[0]?.count || 0) > 0 || jsonInUse) throw new Error('move all nodes out of this location before deleting it');
    if (this.database.enabled) await this.database.query(`DELETE FROM locations WHERE id = ${this.database.placeholders(1)}`, [id]);
    else {
      if (!this.locations.delete(id)) throw new Error('location not found');
      this.save();
    }
    return { id, deleted: true };
  }

  private id(value: unknown) {
    return String(value || '').trim().toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }
  private async inUse(id: string) {
    if (this.database.enabled) {
      const rows = await this.database.query(
        `SELECT COUNT(*) AS count FROM agents WHERE location = ${this.database.placeholders(1)}`,
        [id]
      );
      return Number(rows[0]?.count || 0) > 0;
    }
    return (this.jsonNodeCounts().get(id) || 0) > 0;
  }
  private displayName(id: string) { return id.split(/[-_]/g).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }
  private fromRow(row: any): LocationEntry {
    const date = (value: any) => value instanceof Date ? value.toISOString() : String(value || '');
    return { id: row.id, name: row.name, description: row.description || '', createdAt: date(row.created_at), updatedAt: date(row.updated_at), nodeCount: Number(row.node_count || 0) };
  }
  private jsonNodeCounts() {
    const counts = new Map<string, number>();
    const agentsFile = path.join(__dirname, '..', '..', 'data', 'agents.json');
    if (!fs.existsSync(agentsFile)) return counts;
    for (const agent of JSON.parse(fs.readFileSync(agentsFile, 'utf8')) as Array<{ location?: string }>) {
      const id = this.id(agent.location);
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }
  private save() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.locations.values()), null, 2));
  }
}
