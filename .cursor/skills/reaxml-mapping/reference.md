# REAXML ↔ platform field map (stub)

Fill and expand during M0 schema work. Written now so M6 does not reverse-engineer.

| REAXML / feed concept | Platform table.column | Notes |
|----------------------|----------------------|-------|
| category | listing.channel | sale / rent / sold / leased |
| status | listing.status | draft / pending / live / under_offer / sold / withdrawn |
| price / priceView | listing.price_from, price_to, price_display | numeric + display string |
| bedrooms | property.bedrooms | on property (physical) |
| bathrooms | property.bathrooms | |
| carSpaces | property.car_spaces | |
| landDetails | property.land_area_sqm | |
| building area | property.building_area_sqm | |
| address / G-NAF | property.* + gnaf_pid | |
| inspectionTimes | inspection.* | |
| images (+ main) | media.* + is_main | |
| listingAgent | listing_agent.* + snapshots | never listing.agent_id |
| headline / description | listing.headline, description | |
| external unique id | listing.external_ref + source | portal / reaxml / api |
