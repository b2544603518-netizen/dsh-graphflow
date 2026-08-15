const z: any = new Proxy(() => z, {
  apply: () => z,
  get: () => z,
})
export default z
