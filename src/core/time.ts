export function isExpired(createdAt: number, ttlSeconds: number) {
    return (Date.now() - createdAt) > (ttlSeconds * 1000)
}
