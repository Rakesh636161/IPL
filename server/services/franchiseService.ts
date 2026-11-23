import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import { auditLogs, franchises, userProfiles, users } from '../../src/db/schema.ts';
import { logEvent } from '../lib/logger.ts';

export interface CreateFranchiseInput {
  name: string;
  shortName: string;
  primaryColor: string;
  logoUrl?: string | null;
  ownerName?: string;
  description?: string;
}

export interface UpdateFranchiseInput {
  name?: string;
  shortName?: string;
  primaryColor?: string;
  logoUrl?: string | null;
  ownerName?: string;
  description?: string;
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export function sanitizeFranchiseLogoUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Allow local generated crest assets, HTTPS URLs, or small resized image data URLs (PNG/JPEG/WebP only)
  if (trimmed.startsWith('/src/assets/images/') && trimmed.length <= 300) {
    return trimmed;
  }
  if (/^https:\/\/[^\s]+$/i.test(trimmed) && trimmed.length <= 500) {
    return trimmed;
  }
  if (/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmed) && trimmed.length <= 180_000) {
    return trimmed;
  }
  throw new Error('INVALID_LOGO_URL');
}

export async function listUserFranchises(userId: string) {
  const [ownerUser] = await db
    .select({ id: users.id, uid: users.uid })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const rows = await db
    .select()
    .from(franchises)
    .where(eq(franchises.ownerId, userId))
    .orderBy(desc(franchises.createdAt));

  return rows.map((row) => ({
    ...row,
    ownerUid: ownerUser?.uid || null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function createFranchise(userId: string, input: CreateFranchiseInput) {
  const cleanName = input.name.trim().slice(0, 40);
  const cleanShort = input.shortName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const cleanColor = HEX_COLOR_RE.test(input.primaryColor.trim()) ? input.primaryColor.trim().toUpperCase() : '#F97316';
  const cleanLogo = sanitizeFranchiseLogoUrl(input.logoUrl);
  const cleanDesc = (input.description || '').trim().slice(0, 240);

  if (cleanName.length < 2) throw new Error('INVALID_FRANCHISE_NAME');
  if (cleanShort.length < 2) throw new Error('INVALID_SHORT_NAME');

  const [profile] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const [ownerUser] = await db
    .select({ id: users.id, uid: users.uid })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const cleanOwnerName = (input.ownerName || profile?.displayName || 'Franchise Owner').trim().slice(0, 40);
  if (cleanOwnerName.length < 2) throw new Error('INVALID_OWNER_NAME');

  const existing = await db
    .select()
    .from(franchises)
    .where(eq(franchises.ownerId, userId));

  if (existing.some((f) => f.name.trim().toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('DUPLICATE_FRANCHISE_NAME');
  }

  const [created] = await db
    .insert(franchises)
    .values({
      ownerId: userId,
      name: cleanName,
      shortName: cleanShort,
      primaryColor: cleanColor,
      logoUrl: cleanLogo,
      ownerName: cleanOwnerName,
      description: cleanDesc,
    })
    .returning();

  await db.insert(auditLogs).values({
    actorUserId: userId,
    action: 'FRANCHISE_CREATED',
    resourceType: 'FRANCHISE',
    resourceId: created.id,
    details: { name: cleanName, shortName: cleanShort, primaryColor: cleanColor },
  });

  logEvent('INFO', 'FranchiseService', 'Franchise created', { userId, franchiseId: created.id, name: cleanName });

  return {
    ...created,
    ownerUid: ownerUser?.uid || null,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
  };
}

export async function updateFranchise(userId: string, franchiseId: string, input: UpdateFranchiseInput) {
  const [existing] = await db
    .select()
    .from(franchises)
    .where(eq(franchises.id, franchiseId))
    .limit(1);

  if (!existing) throw new Error('FRANCHISE_NOT_FOUND');
  if (existing.ownerId !== userId) throw new Error('FORBIDDEN');

  const cleanName = input.name !== undefined ? input.name.trim().slice(0, 40) : existing.name;
  const cleanShort =
    input.shortName !== undefined
      ? input.shortName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
      : existing.shortName;
  const cleanColor =
    input.primaryColor !== undefined
      ? HEX_COLOR_RE.test(input.primaryColor.trim())
        ? input.primaryColor.trim().toUpperCase()
        : existing.primaryColor
      : existing.primaryColor;
  const cleanLogo =
    input.logoUrl !== undefined ? sanitizeFranchiseLogoUrl(input.logoUrl) : existing.logoUrl;
  const cleanOwnerName =
    input.ownerName !== undefined ? input.ownerName.trim().slice(0, 40) : existing.ownerName;
  const cleanDesc =
    input.description !== undefined ? input.description.trim().slice(0, 240) : existing.description;

  if (cleanName.length < 2) throw new Error('INVALID_FRANCHISE_NAME');
  if (cleanShort.length < 2) throw new Error('INVALID_SHORT_NAME');
  if (cleanOwnerName.length < 2) throw new Error('INVALID_OWNER_NAME');

  const owned = await db
    .select()
    .from(franchises)
    .where(eq(franchises.ownerId, userId));

  if (
    owned.some(
      (f) => f.id !== franchiseId && f.name.trim().toLowerCase() === cleanName.toLowerCase()
    )
  ) {
    throw new Error('DUPLICATE_FRANCHISE_NAME');
  }

  const [updated] = await db
    .update(franchises)
    .set({
      name: cleanName,
      shortName: cleanShort,
      primaryColor: cleanColor,
      logoUrl: cleanLogo,
      ownerName: cleanOwnerName,
      description: cleanDesc,
      updatedAt: new Date(),
    })
    .where(and(eq(franchises.id, franchiseId), eq(franchises.ownerId, userId)))
    .returning();

  const [ownerUser] = await db
    .select({ id: users.id, uid: users.uid })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    ...updated,
    ownerUid: ownerUser?.uid || null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
}

export async function deleteFranchise(userId: string, franchiseId: string) {
  const [existing] = await db
    .select()
    .from(franchises)
    .where(eq(franchises.id, franchiseId))
    .limit(1);

  if (!existing) throw new Error('FRANCHISE_NOT_FOUND');
  if (existing.ownerId !== userId) throw new Error('FORBIDDEN');

  await db
    .delete(franchises)
    .where(and(eq(franchises.id, franchiseId), eq(franchises.ownerId, userId)));

  return { deleted: true, id: franchiseId };
}
