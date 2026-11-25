import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { apiAdminPatients, ApiError } from "@/lib/api"
import { formatSlotDate } from "@/lib/clinicDate"
import { EmptyState, PageError, PageLoading } from "@/components/async-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function Patients() {
  const [search, setSearch] = useState("")
  const [submitted, setSubmitted] = useState("")

  const patients = useQuery({
    queryKey: ["admin", "patients", submitted],
    queryFn: ({ signal }) => apiAdminPatients({ ...(submitted !== "" && { search: submitted }), limit: 100 }, signal),
  })

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Patients</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Patient directory</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Browse patient records and search by phone prefix or name.
        </p>
      </section>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-950">Directory</CardTitle>
          <CardDescription>Search across registered and provisional patient records.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault()
              setSubmitted(search.trim())
            }}
          >
            <div className="w-full max-w-sm space-y-2">
              <Label htmlFor="patient-search">Search</Label>
              <Input
                id="patient-search"
                className="bg-white"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Phone prefix or name"
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit">
                <Search className="size-4" aria-hidden="true" />
                Search
              </Button>
              {submitted !== "" && (
                <Button type="button" variant="ghost" onClick={() => { setSearch(""); setSubmitted("") }}>
                  Clear
                </Button>
              )}
            </div>
          </form>

          {patients.isPending && <PageLoading label="Loading patients…" />}
          {patients.isError && (
            <PageError
              title="Patients could not be loaded"
              message={patients.error instanceof ApiError ? patients.error.message : undefined}
              onRetry={() => void patients.refetch()}
            />
          )}
          {patients.data?.patients.length === 0 && (
            <EmptyState title="No patients found" description={submitted === "" ? "No patient records yet." : "Try another phone prefix or name."} />
          )}
          {patients.data !== undefined && patients.data.patients.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th scope="col" className="py-3 pr-3 font-medium">Patient</th>
                    <th scope="col" className="py-3 pr-3 font-medium">Contact</th>
                    <th scope="col" className="py-3 pr-3 font-medium">Record</th>
                    <th scope="col" className="py-3 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {patients.data.patients.map((patient) => (
                    <tr key={patient.id} className="align-top">
                      <td className="py-3 pr-3 font-medium text-slate-900">{patient.fullName}</td>
                      <td className="py-3 pr-3 text-slate-600">
                        <div>{patient.phone}</div>
                        <div className="text-xs text-slate-500">{patient.email ?? "No email"}</div>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex flex-wrap gap-1.5">
                          {patient.isProvisional && <Badge variant="outline">Walk-in</Badge>}
                          {patient.isDeactivated && <Badge variant="destructive">Deactivated</Badge>}
                          {!patient.isProvisional && !patient.isDeactivated && <Badge variant="secondary">Registered</Badge>}
                        </div>
                      </td>
                      <td className="py-3 text-slate-600">{formatSlotDate(patient.createdAt.slice(0, 10))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
