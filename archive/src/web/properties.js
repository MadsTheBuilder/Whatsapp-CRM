const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");

async function search() {
  const p = new URLSearchParams();
  for (const k of ["category", "area", "min_beds", "min_price", "max_price", "furnished"]) {
    const v = $(k).value;
    if (v) p.set(k, v);
  }
  const res = await fetch("/api/properties?" + p.toString());
  const data = await res.json();
  $("pulled").textContent = "Listings pulled " + data.pulled_at;
  $("count").textContent = data.count + " properties";

  const grid = $("grid");
  if (!data.listings.length) {
    grid.innerHTML = '<div class="empty">No properties match these filters.</div>';
    return;
  }
  grid.innerHTML = data.listings
    .map((l) => {
      const beds = l.bedrooms === 0 ? "Studio" : l.bedrooms + " bed";
      const per = l.period === "yearly" ? "/yr" : "";
      return `
      <div class="card">
        <img src="${l.image}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
        <div class="body">
          <span class="tag">${l.category === "rent" ? "For Rent" : "For Sale"}${l.furnished === "YES" ? " · Furnished" : ""}</span>
          <div class="price">AED ${fmt(l.price)} <small>${per}</small></div>
          <div class="title">${l.title}</div>
          <div class="loc">${l.location}</div>
          <div class="specs"><span>${beds}</span><span>${l.bathrooms} bath</span><span>${fmt(l.size)} sqft</span></div>
          <div class="agent">${l.agent} · ${l.broker}</div>
          <a class="view" href="${l.url}" target="_blank" rel="noopener">View on PropertyFinder →</a>
        </div>
      </div>`;
    })
    .join("");
}

$("search").addEventListener("click", search);
search();
