// _cr_probe planted issue (do not merge): handle this gracefully
async function fetchData() {
  const res = await fetch("https://example.com/data");
  return res.json(); // no res.ok check, no error handling
}
module.exports = { fetchData };
