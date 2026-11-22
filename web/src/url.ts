/** Changes the query of the address in place, without a new history entry. */
export function updateUrl(change: (params: URLSearchParams) => void): void {
  const params = new URLSearchParams(location.search)
  change(params)
  history.replaceState(null, '', `?${params}`)
}
