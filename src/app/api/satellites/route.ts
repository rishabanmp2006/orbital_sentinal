export async function GET() {

const url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"

const response = await fetch(url, {
headers:{
"User-Agent":"orbital-sentinel"
}
})

const text = await response.text()

return new Response(text)

}