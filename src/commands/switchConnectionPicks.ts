import { ConnectionProfile, loginKindLabel } from '../db/connectionProfiles';

export const EDIT_CONNECTIONS_ID = '__edit_connections__';

export type ConnectionSwitchSource = Pick<
    ConnectionProfile,
    'id' | 'name' | 'loginKind' | 'server' | 'database'
>;

export type ConnectionSwitchPick = {
    id: string;
    label: string;
    description: string;
    picked: boolean;
};

export function connectionSwitchDetail(profile: ConnectionSwitchSource): string {
    const kind = loginKindLabel(profile.loginKind);
    const host = profile.server.trim();
    const database = profile.database.trim();
    if (!host) {
        return `${kind} · not filled in`;
    }
    if (!database) {
        return `${kind} · ${host}`;
    }
    return `${kind} · ${host} / ${database}`;
}

export function connectionSwitchPicks(
    profiles: ConnectionSwitchSource[],
    activeId: string
): ConnectionSwitchPick[] {
    const items = profiles.map((profile) => ({
        id: profile.id,
        label: profile.name,
        description: connectionSwitchDetail(profile),
        picked: profile.id === activeId
    }));
    items.push({
        id: EDIT_CONNECTIONS_ID,
        label: 'Edit connections…',
        description: 'Open the login page',
        picked: false
    });
    return items;
}
