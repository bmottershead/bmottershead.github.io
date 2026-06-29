
A GitHub Pages site providing a simple Clicker/Tally App which
stores the timestamps of clicks in the browser localStorage.  
The localStorage can be archived (committed) upon user request 
back to the GitHub Pages repo, using a Cloudflare Worker as an 
OAuth Proxy. A GitHub Action sends a confirmation email after 
a successful commit of the timestamps.

  + Static Frontend (hosted on GitHub Pages)
  + Backend OAuth Proxy  (Cloudflare Worker and GitHub App)
  + GitHub Content Store (GitHub git repository)
  + Commit triggering CI (GitHub Action emails an archive confirmation)
