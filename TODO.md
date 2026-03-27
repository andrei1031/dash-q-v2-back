# Service Hard Delete Implementation TODO

## Status: [ ] 0% Complete

### Step 1: [✓] Backend Controller (adminController.js)

- Add `exports.hard_delete_admin_service = async (req, res) => { ... }`
- Admin check
- Check usage in queue_entries + services_completed
- If used >0: 409 error
- Else: supabase.delete()
- Mark complete: Update this TODO

### Step 2: [✓] Backend Route (adminRoutes.js)

- Import hard_delete_admin_service
- Add `router.delete('/services/:id/hard-delete', hard_delete_admin_service);`
- Mark complete

### Step 3: [✓] Frontend Update (../dash-q-v2-front/src/Components/AdminAppLayout.js)

- Read file
- Add 'Delete Forever' button next to 'Archive' (red, confirm dialog)
- axios.delete(`/admin/services/${id}/hard-delete`, { data: { userId } })
- Handle error alerts
- Mark complete

### Step 4: [✓] Test Complete

✅ **Backend**: New controller/route for `/admin/services/:id/hard-delete` (checks queue_entries/services_completed refs, deletes if safe).

✅ **Frontend**: Admin Services tab now has:

- **Archive** button (soft delete, existing)
- **💀 Hard Del** button (permanent, double-confirm 'PERMANENT', error handling)

**Test it:**

1. Backend dev: `npm run dev`
2. Frontend dev: `cd ../dash-q-v2-front && npm run dev`
3. Login Admin → Services tab → Add service → Archive/Hard Del → Test block on used service.

**Task complete!**
